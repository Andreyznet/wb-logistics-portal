package ru.rostprom.marshrut;
import android.app.*;
import android.content.Intent;
import com.google.firebase.messaging.*;
import java.util.Map;

public final class PushService extends FirebaseMessagingService {
    @Override public void onNewToken(String token){PushRegistration.save(this,token);}
    @Override public void onMessageReceived(RemoteMessage message){
        DeviceAuth.init(this);if(!Prefs.enabled(this)||DeviceAuth.token().isEmpty())return;
        NotificationManager manager=getSystemService(NotificationManager.class);if(!manager.areNotificationsEnabled())return;
        Prefs.get(this).edit().putBoolean("pushReady",true).putString("pushStatus","FCM подключён").apply();
        Map<String,String> data=message.getData();
        if(message.getPriority()==RemoteMessage.PRIORITY_HIGH){
            try{startForegroundService(new Intent(this,MonitorService.class).setAction("PUSH"));return;}catch(Exception ignored){}
        }
        // Downgraded FCM messages cannot start an FGS. Always show a notification instead.
        manager.createNotificationChannel(new NotificationChannel("fcm_fallback","Push-уведомления",NotificationManager.IMPORTANCE_HIGH));
        PendingIntent tap=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        String kind=data.getOrDefault("kind","alert"),title=kind.equals("alert")?"Получена заявка":kind.equals("bot_enabled")?"Бот запущен":kind.equals("bot_disabled")?"Бот остановлен":"Сообщение бота";
        int id=300000+(data.getOrDefault("event","").hashCode()&65535);
        manager.notify(id,new Notification.Builder(this,"fcm_fallback").setSmallIcon(R.drawable.ic_notification).setContentTitle(title).setContentText("Откройте приложение для просмотра подробностей.").setContentIntent(tap).setAutoCancel(true).setVisibility(Notification.VISIBILITY_PRIVATE).build());
    }
}
