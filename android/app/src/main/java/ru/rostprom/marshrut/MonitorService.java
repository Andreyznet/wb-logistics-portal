package ru.rostprom.marshrut;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.*;
import android.os.*;
import org.json.*;
import java.util.*;
import java.util.concurrent.*;

public final class MonitorService extends Service {
    static final String CH_SERVICE="duty",CH_ALERT="assignments",CH_EVENTS="bot_events",UPDATE="ru.rostprom.marshrut.UPDATE";
    private ScheduledExecutorService executor;private NotificationManager notifications;private PowerManager.WakeLock wakeLock;
    private final AlarmPlayer alarm=new AlarmPlayer();private volatile boolean stopped=false;private int networkFailures=0;private volatile long retryAt=0;
    private final Set<Integer> shown=ConcurrentHashMap.newKeySet();private boolean scheduled=false;private ScheduledFuture<?> polling;private volatile int latestStartId;
    @Override public void onCreate(){
        super.onCreate();DeviceAuth.init(this);notifications=getSystemService(NotificationManager.class);
        NotificationChannel duty=new NotificationChannel(CH_SERVICE,"Фоновая связь",NotificationManager.IMPORTANCE_LOW);duty.setSound(null,null);
        NotificationChannel alerts=new NotificationChannel(CH_ALERT,"Принятые и найденные заявки",NotificationManager.IMPORTANCE_HIGH);alerts.setDescription("Окно с данными и повторяющийся сигнал до подтверждения ОК");alerts.setSound(null,null);alerts.enableVibration(true);
        NotificationChannel events=new NotificationChannel(CH_EVENTS,"Запуск, остановка и ошибки бота",NotificationManager.IMPORTANCE_HIGH);
        notifications.createNotificationChannels(Arrays.asList(duty,alerts,events));
        wakeLock=((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"Marshrut:duty");
        wakeLock.setReferenceCounted(false);executor=Executors.newSingleThreadScheduledExecutor();
        ((android.net.ConnectivityManager)getSystemService(CONNECTIVITY_SERVICE)).registerDefaultNetworkCallback(networkChanges);
    }
    private PendingIntent openPortal(){return PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);}
    private Notification duty(String text){
        return new Notification.Builder(this,CH_SERVICE).setSmallIcon(R.drawable.ic_notification).setContentTitle("Маршрут · фоновая связь").setContentText(text).setContentIntent(openPortal()).setOngoing(true).setOnlyAlertOnce(true).addAction(new Notification.Action.Builder(null,"Открыть приложение",openPortal()).build()).build();
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        latestStartId=startId;
        if(intent!=null&&"ACK".equals(intent.getAction())){long id=intent.getLongExtra("id",0);Prefs.acknowledge(this,id);ReceiptJob.schedule(this);PortalApi.cancelWait();retryAt=0;alarm.stop();notifications.cancel(alertId(id));}

        if(intent!=null&&"STOP".equals(intent.getAction())){Prefs.get(this).edit().putBoolean("enabled",false).apply();PushRegistration.ensure(this,true);stopSelf();return START_NOT_STICKY;}
        if(!Prefs.enabled(this)||(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)){stopSelf();return START_NOT_STICKY;}
        if(Build.VERSION.SDK_INT>=34)startForeground(1,duty("Подключаемся к порталу…"),ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);else startForeground(1,duty("Подключаемся к порталу…"));
        Prefs.get(this).edit().putBoolean("running",true).apply();
        if(intent!=null&&"ACK".equals(intent.getAction())){
            executor.execute(this::sync);
        }else if(intent!=null&&("REFRESH".equals(intent.getAction())||"PUSH".equals(intent.getAction()))){PortalApi.cancelWait();retryAt=0;executor.execute(this::sync);}
        if(pushReady()){
            if(polling!=null){polling.cancel(false);polling=null;}scheduled=false;
            if(intent==null||(!"ACK".equals(intent.getAction())&&!"REFRESH".equals(intent.getAction())&&!"PUSH".equals(intent.getAction())))executor.execute(this::sync);
        }else if(!scheduled){
            scheduled=true;
            Prefs.get(this).edit().putBoolean("running",true).apply();polling=executor.scheduleWithFixedDelay(this::sync,0,1,TimeUnit.SECONDS);
        }
        return pushReady()?START_NOT_STICKY:START_STICKY;
    }
    private void event(long id,String kind,String message){
        if(message==null||message.isEmpty())return;
        String fingerprint=kind+":"+message;long now=System.currentTimeMillis();
        String key="event_"+Integer.toHexString(fingerprint.hashCode());
        if(!kind.equals("bot_enabled")&&!kind.equals("bot_disabled")&&now-Prefs.get(this).getLong(key,0)<300000)return;
        notifications.notify(200000+(int)(id%100000),new Notification.Builder(this,CH_EVENTS).setSmallIcon(R.drawable.ic_notification).setContentTitle(kind.equals("bot_enabled")?"Бот запущен":kind.equals("bot_disabled")?"Бот остановлен":kind.equals("api_recovered")?"Связь восстановлена":"Ошибка работы").setContentText(message).setStyle(new Notification.BigTextStyle().bigText(message)).setContentIntent(openPortal()).setAutoCancel(true).setVisibility(Notification.VISIBILITY_PRIVATE).build());
        Prefs.get(this).edit().putLong(key,now).apply();
    }
    private int alertId(long id){return 1000+(int)(id%100000);}
    private boolean pushReady(){return Prefs.get(this).getBoolean("pushReady",false);}
    private synchronized void sync(){
        int syncStartId=latestStartId;
        if(stopped||System.currentTimeMillis()<retryAt)return;
        if(!notifications.areNotificationsEnabled()){stopSelf();return;}
        String credential=DeviceAuth.token();
        if(credential.isEmpty()){failure("Подключите телефон: откройте приложение и войдите в кабинет.");stopSelf();return;}
        try {
            wakeLock.acquire(10*60*1000L);
            if(!ReceiptJob.flush(this,credential))ReceiptJob.schedule(this);
            Prefs.get(this).edit().putLong("lastAttempt",System.currentTimeMillis()).apply();
            String cursor=Prefs.get(this).getString("cursor","");
            String session=DeviceAuth.token();
            String revision=Prefs.get(this).getString("revision","");
            String query=cursor.isEmpty()?"":"?since="+cursor;
            if(!pushReady()&&!revision.isEmpty()&&Prefs.get(this).getStringSet("acks",Collections.emptySet()).isEmpty())query+=(query.isEmpty()?"?":"&")+"wait=25&revision="+revision;
            JSONObject data=PortalApi.call("mobile/sync"+query,false,credential);
            if(stopped||!java.util.Objects.equals(session,DeviceAuth.token()))return;
            long user=data.getJSONObject("user").getLong("id");
            long previous=Prefs.get(this).getLong("user",0);
            if(previous!=0&&previous!=user){alarm.stop();notifications.cancelAll();shown.clear();Prefs.clearAccount(this);cursor="";data=PortalApi.call("mobile/sync",false);}
            Prefs.get(this).edit().putLong("user",user).apply();
            JSONArray entries=data.getJSONArray("events");for(int i=0;i<entries.length();i++){JSONObject e=entries.getJSONObject(i);event(e.getLong("id"),e.getString("kind"),e.optString("message"));}
            JSONObject bot=data.getJSONObject("bot");String status=bot.getBoolean("enabled")?"Бот запущен":"Бот остановлен";
            if(bot.optInt("apiErrors")>0)status+=" · ошибки API: "+bot.getInt("apiErrors");
            if(!bot.isNull("error"))status+=" · "+bot.getString("error");
            if(cursor.isEmpty()&&bot.optInt("apiErrors")>0)event(99998,"api_error","Ошибки API: "+bot.getInt("apiErrors"));
            if(cursor.isEmpty()&&!bot.isNull("error"))event(99999,"poll_failed",bot.getString("error"));
            JSONArray alerts=data.getJSONArray("alerts"),queue=new JSONArray();Set<Integer> current=new HashSet<>();
            for(int i=0;i<alerts.length();i++){
                if(stopped||!credential.equals(DeviceAuth.token()))return;
                JSONObject a=alerts.getJSONObject(i);long id=a.getLong("id");if(Prefs.acknowledged(this,id))continue;
                queue.put(a);current.add(alertId(id));JSONObject p=a.getJSONObject("payload");
                if(!shown.contains(alertId(id))){
                    String title=p.optBoolean("test")?"Тест уведомления":p.optBoolean("observed")?"Найдена заявка":"Заявка взята в работу";
                    Intent open=new Intent(this,AlertActivity.class).putExtra("id",id);
                    PendingIntent tap=PendingIntent.getActivity(this,alertId(id),open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
                    PendingIntent ack=PendingIntent.getService(this,alertId(id),new Intent(this,MonitorService.class).setAction("ACK").putExtra("id",id),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
                    String text="Маршрут "+p.optString("routeId")+" · WB №"+p.optString("id")+"\n"+p.optString("driver")+"\n"+p.optString("vehicle");
                    notifications.notify(alertId(id),new Notification.Builder(this,CH_ALERT).setSmallIcon(R.drawable.ic_notification).setContentTitle(title).setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text)).setContentIntent(tap).setOngoing(true).setCategory(Notification.CATEGORY_EVENT).setVisibility(Notification.VISIBILITY_PRIVATE).addAction(new Notification.Action.Builder(null,"ОК",ack).build()).build());
                }
            }
            queue=Prefs.saveQueue(this,queue);Set<Integer> visible=new HashSet<>();for(int i=0;i<queue.length();i++)visible.add(alertId(queue.getJSONObject(i).getLong("id")));for(int id:current)if(!visible.contains(id))notifications.cancel(id);current=visible;
            for(int old:shown)if(!current.contains(old))notifications.cancel(old);shown.clear();shown.addAll(current);
            Prefs.get(this).edit().putString("revision",data.optString("revision","")).putString("cursor",Long.toString(data.getLong("cursor"))).putString("bot",status).putLong("lastSync",System.currentTimeMillis()).remove("connectionError").apply();
            JSONObject settings=data.getJSONObject("notification");
            if(stopped)return;
            if(queue.length()>0&&notifications.getNotificationChannel(CH_ALERT).getImportance()!=NotificationManager.IMPORTANCE_NONE){
                if(Build.VERSION.SDK_INT>=34)startForeground(1,duty(status),ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE|ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
                JSONObject first=queue.getJSONObject(0);synchronized(Prefs.class){if(!Prefs.acknowledged(this,first.getLong("id")))alarm.play(this,Long.toString(first.getLong("id")),settings.optString("soundId","pulse-alarm"),settings.optInt("volume",100));else alarm.stop();}
            }else{alarm.stop();if(Build.VERSION.SDK_INT>=34)startForeground(1,duty(status),ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);}
            notifications.notify(1,duty(status));
            if(networkFailures>=2)event(99996,"api_recovered","Связь приложения с порталом восстановлена.");networkFailures=0;retryAt=0;
            sendBroadcast(new Intent(UPDATE).setPackage(getPackageName()));
            if(pushReady()&&queue.length()==0&&Prefs.get(this).getStringSet("acks",Collections.emptySet()).isEmpty()&&!data.optBoolean("hasMore"))stopSelfResult(syncStartId);
            else if(pushReady()&&(data.optBoolean("hasMore")||!Prefs.get(this).getStringSet("acks",Collections.emptySet()).isEmpty()))executor.execute(this::sync);
        }catch(PortalApi.WaitCancelled ignored){return;}catch(PortalApi.ApiException e){
            if(stopped)return;
            if(e.status==401){alarm.stop();AccountAccess.revoke(this,credential);stopSelf();}
            else failure("Портал вернул HTTP "+e.status+". Проверьте обновление сервера.");
        }catch(Exception e){failure(e instanceof java.io.IOException?"Нет связи с порталом. Проверьте интернет.":"Ошибка приложения: "+e.getClass().getSimpleName()+". Обновите приложение и сервер.");}
        finally{if(wakeLock.isHeld())wakeLock.release();}
    }
    private void failure(String message){if(stopped)return;networkFailures++;retryAt=System.currentTimeMillis()+Math.min(60000,1000L*(1L<<Math.min(networkFailures,6)));Prefs.get(this).edit().putString("connectionError",message).apply();sendBroadcast(new Intent(UPDATE).setPackage(getPackageName()));notifications.notify(1,duty(message));if(networkFailures>=2)event(99995,"network",message);if(pushReady())executor.schedule(this::sync,Math.max(1000,retryAt-System.currentTimeMillis()),TimeUnit.MILLISECONDS);}
    private final android.net.ConnectivityManager.NetworkCallback networkChanges=new android.net.ConnectivityManager.NetworkCallback(){
        @Override public void onAvailable(android.net.Network network){if(executor!=null&&!executor.isShutdown()&&(scheduled||pushReady())){retryAt=0;PortalApi.cancelWait();executor.execute(MonitorService.this::sync);}}
    };
    @Override public void onDestroy(){stopped=true;PortalApi.cancelWait();try{((android.net.ConnectivityManager)getSystemService(CONNECTIVITY_SERVICE)).unregisterNetworkCallback(networkChanges);}catch(Exception ignored){}stopped=true;Prefs.get(this).edit().putBoolean("running",false).apply();if(executor!=null)executor.shutdownNow();alarm.stop();if(wakeLock!=null&&wakeLock.isHeld())wakeLock.release();for(int id:shown)notifications.cancel(id);stopForeground(STOP_FOREGROUND_REMOVE);super.onDestroy();}
    @Override public android.os.IBinder onBind(Intent intent){return null;}
}
