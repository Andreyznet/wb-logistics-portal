package ru.rostprom.marshrut;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import org.json.*;
import java.util.*;
import java.io.OutputStream;

public final class MainActivity extends Activity {
    private WebView web;private TextView connection;private final Handler main=new Handler();
    private ValueCallback<Uri[]> fileCallback;private byte[] download;private boolean resumed=false,permissionAsked=false,alertOpen=false;
    private final BroadcastReceiver updates=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){refreshNativeState();}};
    @Override public void onCreate(Bundle saved){
        super.onCreate(saved);Prefs.get(this).edit().putBoolean("running",false).apply();
        LinearLayout layout=new LinearLayout(this);layout.setOrientation(LinearLayout.VERTICAL);layout.setBackgroundColor(0xfff6f8fb);
        layout.setOnApplyWindowInsetsListener((v,insets)->{v.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets.consumeSystemWindowInsets();});
        LinearLayout bar=new LinearLayout(this);bar.setGravity(Gravity.CENTER_VERTICAL);bar.setPadding(dp(12),dp(4),dp(12),dp(4));
        TextView brand=new TextView(this);brand.setText("маршрут");brand.setTextSize(19);brand.setTextColor(0xff10243a);brand.setTypeface(null,1);bar.addView(brand,new LinearLayout.LayoutParams(0,dp(52),1));
        Button reload=new Button(this);reload.setText("↻");reload.setContentDescription("Обновить портал");bar.addView(reload,new LinearLayout.LayoutParams(dp(56),dp(52)));
        Button menu=new Button(this);menu.setText("⋯");menu.setContentDescription("Настройки приложения");bar.addView(menu,new LinearLayout.LayoutParams(dp(56),dp(52)));layout.addView(bar);
        connection=new TextView(this);connection.setPadding(dp(16),dp(4),dp(16),dp(8));connection.setTextSize(12);layout.addView(connection);
        web=new WebView(this);layout.addView(web,new LinearLayout.LayoutParams(-1,0,1));setContentView(layout);
        WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);settings.setUserAgentString(settings.getUserAgentString()+" MarshrutAndroid/1.0");settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptCookie(true);CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        web.addJavascriptInterface(new Downloads(),"MarshrutFiles");
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){Uri u=r.getUrl();if(trusted(u.toString()))return false;if("https".equals(u.getScheme())){try{startActivity(new Intent(Intent.ACTION_VIEW,u));}catch(Exception ignored){}}return true;}
            @Override public void onPageFinished(WebView v,String url){CookieManager.getInstance().flush();if(trusted(url))probeLogin();}
            @Override public void onReceivedError(WebView v,WebResourceRequest r,WebResourceError error){if(r.isForMainFrame())connection.setText("Нет связи. Проверьте интернет и нажмите ↻.");}
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public boolean onShowFileChooser(WebView v,ValueCallback<Uri[]> callback,FileChooserParams params){if(fileCallback!=null)fileCallback.onReceiveValue(null);fileCallback=callback;try{startActivityForResult(params.createIntent(),10);return true;}catch(Exception e){fileCallback=null;return false;}}
        });
        web.setDownloadListener((url,agent,disposition,mime,length)->{
            if(!trusted(web.getUrl()))return;
            if(url.startsWith("blob:"+PortalApi.ORIGIN+"/"))web.evaluateJavascript("fetch("+JSONObject.quote(url)+").then(r=>r.blob()).then(b=>{if(b.size>5242880)throw Error();let f=new FileReader();f.onload=()=>MarshrutFiles.save('marshrut-export.json',String(f.result).split(',')[1]);f.readAsDataURL(b);})",null);
            else if(trusted(url))startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(url)));
        });
        reload.setOnClickListener(v->web.reload());menu.setOnClickListener(v->settings());
        if(Build.VERSION.SDK_INT>=33)registerReceiver(updates,new IntentFilter(MonitorService.UPDATE),Context.RECEIVER_NOT_EXPORTED);else registerReceiver(updates,new IntentFilter(MonitorService.UPDATE));
        web.loadUrl(PortalApi.ORIGIN);refreshNativeState();
    }
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private boolean trusted(String url){if(url==null)return false;Uri u=Uri.parse(url);return "https".equals(u.getScheme())&&"open-key.ru".equals(u.getHost())&&(u.getPort()==-1||u.getPort()==443);}
    private final Runnable probe=new Runnable(){public void run(){if(resumed){probeLogin();main.postDelayed(this,3000);}}};
    private void probeLogin(){
        if(!trusted(web.getUrl()))return;
        web.evaluateJavascript("(typeof state!=='undefined'&&state.user)?String(state.user.id):''",value->{
            if(!resumed)return;
            boolean signedIn=value!=null&&!value.equals("\"\"")&&!value.equals("null");
            if(signedIn){CookieManager.getInstance().flush();startMonitoring();}
            else if(Prefs.get(this).getLong("user",0)!=0){stopService(new Intent(this,MonitorService.class));Prefs.clearAccount(this);}
        });
    }
    private void startMonitoring(){
        if(!Prefs.enabled(this))return;
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED){
            if(!permissionAsked){permissionAsked=true;new AlertDialog.Builder(this).setTitle("Уведомления о заявках").setMessage("Разрешите уведомления, чтобы получать заявки и ошибки при свёрнутом приложении. Фоновая связь видна постоянным уведомлением; звук заявки повторяется до ОК.").setPositiveButton("Разрешить",(d,w)->requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},20)).setNegativeButton("Позже",null).show();}return;
        }
        if(!Prefs.get(this).getBoolean("running",false)){try{startForegroundService(new Intent(this,MonitorService.class));}catch(Exception e){connection.setText("Не удалось включить фон. Откройте настройки приложения.");}}
    }
    private void refreshNativeState(){
        if(connection==null)return;
        long last=Prefs.get(this).getLong("lastSync",0);
        connection.setText(!Prefs.enabled(this)?"Фоновые уведомления выключены":!getSystemService(NotificationManager.class).areNotificationsEnabled()?"Разрешите уведомления в настройках Android":last==0?"Войдите в кабинет для фоновой связи":Prefs.get(this).getString("bot","Подключение…")+" · связь "+(System.currentTimeMillis()-last<45000?"есть":"ожидается"));
        if(resumed&&!alertOpen){try{JSONArray queue=new JSONArray(Prefs.get(this).getString("queue","[]"));Set<String> acks=Prefs.get(this).getStringSet("acks",Collections.emptySet());for(int i=0;i<queue.length();i++){long id=queue.getJSONObject(i).getLong("id");if(!acks.contains(Long.toString(id))){alertOpen=true;startActivityForResult(new Intent(this,AlertActivity.class).putExtra("id",id),30);break;}}}catch(Exception ignored){}}
    }
    private void settings(){
        String[] choices={Prefs.enabled(this)?"Выключить фоновую связь":"Включить фоновую связь","Разрешения и звуки Android","Работа без ограничений батареи","О приложении"};
        new AlertDialog.Builder(this).setTitle("Настройки приложения").setItems(choices,(d,which)->{
            if(which==0){boolean enable=!Prefs.enabled(this);Prefs.get(this).edit().putBoolean("enabled",enable).apply();if(enable){permissionAsked=false;startMonitoring();}else stopService(new Intent(this,MonitorService.class));refreshNativeState();}
            if(which==1)startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,getPackageName()));
            if(which==2){new AlertDialog.Builder(this).setTitle("Фоновая работа").setMessage("В настройках батареи разрешите приложению работу без ограничений. На Xiaomi, Honor и других устройствах также может требоваться автозапуск. Постоянная связь во время смены увеличивает расход батареи.").setPositiveButton("Открыть настройки",(x,y)->startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName())))).setNegativeButton("Закрыть",null).show();}
            if(which==3)new AlertDialog.Builder(this).setTitle("Маршрут 1.0.0").setMessage("Все функции портала + системные уведомления Android. Сервер: open-key.ru. Фоновая связь проверяет события примерно каждые 15 секунд. При отсутствии сети доставка задерживается. После принудительной остановки или перезагрузки откройте приложение снова. Изменить личный сигнал можно в профиле портала.").setPositiveButton("ОК",null).show();
        }).show();
    }
    private final class Downloads {
        @JavascriptInterface public void save(String name,String base64){
            if(base64==null||base64.length()>7*1024*1024)return;
            main.post(()->{if(!trusted(web.getUrl()))return;try{download=android.util.Base64.decode(base64,android.util.Base64.DEFAULT);if(download.length>5*1024*1024){download=null;return;}Intent save=new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/json").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE,"marshrut-export.json");startActivityForResult(save,11);}catch(Exception e){download=null;}});
        }
    }
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results){super.onRequestPermissionsResult(request,permissions,results);if(request==20&&results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED)startMonitoring();refreshNativeState();}
    @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request==10&&fileCallback!=null){fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result,data));fileCallback=null;}if(request==11){if(result==RESULT_OK&&data!=null&&download!=null)try(OutputStream out=getContentResolver().openOutputStream(data.getData())){out.write(download);Toast.makeText(this,"Файл сохранён",Toast.LENGTH_SHORT).show();}catch(Exception e){Toast.makeText(this,"Не удалось сохранить файл",Toast.LENGTH_LONG).show();}download=null;}if(request==30){alertOpen=false;main.postDelayed(this::refreshNativeState,1500);}}
    @Override protected void onResume(){super.onResume();resumed=true;main.post(probe);refreshNativeState();}
    @Override protected void onPause(){resumed=false;main.removeCallbacks(probe);CookieManager.getInstance().flush();super.onPause();}
    @Override public void onBackPressed(){if(web.canGoBack())web.goBack();else moveTaskToBack(true);}
    @Override protected void onDestroy(){unregisterReceiver(updates);main.removeCallbacksAndMessages(null);if(fileCallback!=null)fileCallback.onReceiveValue(null);web.removeJavascriptInterface("MarshrutFiles");web.destroy();super.onDestroy();}
}
