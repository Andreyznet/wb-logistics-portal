package ru.rostprom.marshrut;
import android.app.*;
import android.content.*;
import android.net.Uri;
import android.provider.Settings;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.security.*;

final class AppUpdater {
 private static boolean busy=false;
 static synchronized void check(Activity a,boolean manual){
  if(busy||DeviceAuth.token().isEmpty())return;busy=true;
  final String credential=DeviceAuth.token(),origin=PortalApi.ORIGIN;
  new Thread(()->{try{
   JSONObject update=PortalApi.call("mobile/app-update",false,credential);
   int installed=a.getPackageManager().getPackageInfo(a.getPackageName(),0).versionCode;
   if(!credential.equals(DeviceAuth.token())||!origin.equals(PortalApi.ORIGIN))return;
   a.runOnUiThread(()->{if(a.isFinishing()||a.isDestroyed())return;
    if(update.optInt("versionCode")<=installed){if(manual)Toast.makeText(a,"Установлена последняя версия",Toast.LENGTH_SHORT).show();return;}
    new AlertDialog.Builder(a).setTitle("Доступно обновление "+update.optString("versionName")).setMessage("Установить новую версию приложения «Маршрут»?").setPositiveButton("Обновить",(d,w)->download(a,update,credential,origin)).setNegativeButton("Позже",null).show();
   });
  }catch(Exception e){if(manual)a.runOnUiThread(()->Toast.makeText(a,"Не удалось проверить обновление. Проверьте подключение и вход в приложение.",Toast.LENGTH_LONG).show());}
  finally{synchronized(AppUpdater.class){busy=false;}}},"app-update-check").start();
 }
 private static void download(Activity a,JSONObject update,String credential,String origin){
  ProgressDialog progress=new ProgressDialog(a);progress.setMessage("Скачиваем обновление…");progress.setCancelable(false);progress.show();
  new Thread(()->{HttpURLConnection c=null;File temp=new File(a.getCacheDir(),"marshrut-update.tmp.apk");try{
   if(!"mobile/app-update/apk".equals(update.optString("path")))throw new IOException();
   long expected=update.getLong("size");if(expected<1||expected>100*1024*1024)throw new IOException();
   c=(HttpURLConnection)new URL(origin+"/portal-api/mobile/app-update/apk").openConnection();c.setInstanceFollowRedirects(false);c.setConnectTimeout(15000);c.setReadTimeout(30000);c.setRequestProperty("Authorization","Bearer "+credential);
   if(c.getResponseCode()!=200||!String.valueOf(c.getContentType()).contains("application/vnd.android.package-archive"))throw new IOException();
   MessageDigest digest=MessageDigest.getInstance("SHA-256");long total=0;
   try(InputStream in=c.getInputStream();OutputStream out=new FileOutputStream(temp)){byte[] b=new byte[32768];int n;while((n=in.read(b))!=-1){total+=n;if(total>expected)throw new IOException();out.write(b,0,n);digest.update(b,0,n);}}
   StringBuilder sha=new StringBuilder();for(byte b:digest.digest())sha.append(String.format("%02x",b&255));
   if(total!=expected||!sha.toString().equals(update.optString("sha256"))||!credential.equals(DeviceAuth.token())||!origin.equals(PortalApi.ORIGIN))throw new IOException();
   android.content.pm.PackageInfo archive=a.getPackageManager().getPackageArchiveInfo(temp.getPath(),android.content.pm.PackageManager.GET_SIGNATURES);
   android.content.pm.PackageInfo current=a.getPackageManager().getPackageInfo(a.getPackageName(),android.content.pm.PackageManager.GET_SIGNATURES);
   if(archive==null||!a.getPackageName().equals(archive.packageName)||archive.versionCode<=current.versionCode||archive.signatures==null||!java.util.Arrays.equals(archive.signatures,current.signatures))throw new IOException();
   File target=new File(a.getCacheDir(),"marshrut-update.apk");if(!temp.renameTo(target))throw new IOException();
   a.runOnUiThread(()->{progress.dismiss();if(!a.isFinishing()&&!a.isDestroyed())install(a);});
  }catch(Exception e){temp.delete();a.runOnUiThread(()->{progress.dismiss();Toast.makeText(a,"Не удалось скачать или проверить обновление. Повторите позже.",Toast.LENGTH_LONG).show();});}finally{if(c!=null)c.disconnect();}},"app-update-download").start();
 }
 static void install(Activity a){try{
  if(!a.getPackageManager().canRequestPackageInstalls()){
   new AlertDialog.Builder(a).setTitle("Разрешить обновление").setMessage("Разрешите приложению «Маршрут» устанавливать обновления. После возврата откроется установка.").setPositiveButton("Открыть настройки",(d,w)->a.startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+a.getPackageName())),61)).setNegativeButton("Позже",null).show();return;
  }
  a.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse("content://"+a.getPackageName()+".updates/marshrut.apk"),"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
 }catch(Exception e){Toast.makeText(a,"Не удалось открыть установку обновления",Toast.LENGTH_LONG).show();}}
}
