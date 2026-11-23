package ru.rostprom.marshrut;
import android.app.NotificationManager;
import android.content.*;
import android.os.*;
import android.webkit.CookieManager;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

final class AccountAccess {
    static final String REVOKED="ru.rostprom.marshrut.ACCESS_REVOKED";
    private static String lastCredential="";private static long lastHeartbeat=0;private static boolean previousForeground=false;
    static IntentFilter filter(){IntentFilter f=new IntentFilter(MonitorService.UPDATE);f.addAction(REVOKED);return f;}
    static String fingerprint(String credential){try{StringBuilder out=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(credential.getBytes(StandardCharsets.UTF_8)))out.append(String.format("%02x",b&255));return out.toString();}catch(Exception e){return "";}}
    static void revoke(Context c,String expected){
        DeviceAuth.init(c);synchronized(AccountAccess.class){if(expected.isEmpty()||!expected.equals(DeviceAuth.token()))return;DeviceAuth.clear();Prefs.clearAccount(c);Prefs.get(c).edit().putBoolean("accessRevoked",true).apply();}
        new Handler(Looper.getMainLooper()).post(()->{
            if(!DeviceAuth.token().isEmpty())return;
            c.stopService(new Intent(c,MonitorService.class));c.getSystemService(NotificationManager.class).cancelAll();
            CookieManager.getInstance().removeAllCookies(done->{CookieManager.getInstance().flush();c.sendBroadcast(new Intent(REVOKED).setPackage(c.getPackageName()));});
        });
    }
    static synchronized void heartbeat(Context c,boolean foreground){
        DeviceAuth.init(c);String credential=DeviceAuth.token();if(credential.isEmpty())return;
        long now=System.currentTimeMillis();if(credential.equals(lastCredential)&&foreground==previousForeground&&now-lastHeartbeat<60000)return;lastCredential=credential;previousForeground=foreground;lastHeartbeat=now;
        new Thread(()->{try{JSONObject body=new JSONObject();body.put("foreground",foreground);PortalApi.post("mobile/heartbeat",body,credential);}catch(PortalApi.ApiException e){if(e.status==401)revoke(c,credential);}catch(Exception ignored){}},"app-presence").start();
    }
}
