package ru.rostprom.marshrut;
import android.app.*;
import android.app.job.*;
import android.content.*;
import android.os.*;
import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONObject;

final class PushRegistration {
    private static long lastEnsure=0;
    static synchronized void ensure(Context c,boolean force){
        if(!force&&System.currentTimeMillis()-lastEnsure<60000)return;lastEnsure=System.currentTimeMillis();
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token->save(c,token)).addOnFailureListener(e->Prefs.get(c).edit().putString("connectionError","FCM: не удалось зарегистрировать телефон. Проверьте Google Play services и интернет.").apply());
    }
    static void save(Context c,String token){
        Prefs.get(c).edit().putString("fcmToken",token).apply();
        ((JobScheduler)c.getSystemService(Context.JOB_SCHEDULER_SERVICE)).schedule(new JobInfo.Builder(7001,new ComponentName(c,PushRegistrationJob.class)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setBackoffCriteria(30000,JobInfo.BACKOFF_POLICY_EXPONENTIAL).build());
        new Thread(()->register(c),"register-push").start();
    }
    static synchronized boolean register(Context c){
        DeviceAuth.init(c);String credential=DeviceAuth.token(),token=Prefs.get(c).getString("fcmToken","");if(credential.isEmpty()||token.isEmpty())return true;
        try{JSONObject body=new JSONObject();body.put("token",token);body.put("enabled",Prefs.enabled(c)&&c.getSystemService(NotificationManager.class).areNotificationsEnabled());
            body.put("deviceName",Build.MANUFACTURER+" "+Build.MODEL);body.put("appVersion","1.1.7");JSONObject result=PortalApi.post("mobile/push-token",body,credential);if(!credential.equals(DeviceAuth.token()))return true;
            boolean ready=result.optBoolean("configured");Prefs.get(c).edit().putBoolean("pushReady",ready).putString("pushStatus",ready?"FCM подключён":"FCM: требуется настройка отправки на сервере").apply();
            if(ready&&Prefs.get(c).getBoolean("running",false))try{c.startService(new Intent(c,MonitorService.class).setAction("PUSH"));}catch(IllegalStateException ignored){}
            return true;
        }catch(PortalApi.ApiException e){if(e.status==401)AccountAccess.revoke(c,credential);return false;}catch(Exception e){Prefs.get(c).edit().putString("pushStatus","FCM: регистрация ожидает подключения").apply();return false;}
    }
}
