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
    private final long openedAt=System.currentTimeMillis();private boolean openSyncRequested=false;private WebView web;private LinearLayout root;private TextView connection;private final Handler main=new Handler();
    private boolean updateChecked=false;
    private ValueCallback<Uri[]> fileCallback;private byte[] download;private boolean resumed=false,permissionAsked=false,alertOpen=false,connecting=false;private long connectingUser=0;
    private final BroadcastReceiver updates=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){if(AccountAccess.REVOKED.equals(i.getAction())){connecting=false;openSyncRequested=false;download=null;web.clearHistory();web.loadUrl(PortalApi.ORIGIN);Toast.makeText(MainActivity.this,"Доступ отозван. Обратитесь к администратору.",Toast.LENGTH_LONG).show();}refreshNativeState();}};
    @Override public void onCreate(Bundle saved){
        super.onCreate(saved);DeviceAuth.init(this);if(!Prefs.get(this).getStringSet("acks",Collections.emptySet()).isEmpty())ReceiptJob.schedule(this);Prefs.get(this).edit().putBoolean("running",false).apply();
        LinearLayout layout=new LinearLayout(this);layout.setOrientation(LinearLayout.VERTICAL);layout.setBackgroundColor(Prefs.get(this).getString("theme","light").equals("dark")?0xff090d16:0xfff6f8fb);root=layout;
        layout.setOnApplyWindowInsetsListener((v,insets)->{v.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets.consumeSystemWindowInsets();});
        connection=new TextView(this); // Diagnostics live in profile settings, not a second toolbar.
        web=new WebView(this);layout.addView(web,new LinearLayout.LayoutParams(-1,0,1));setContentView(layout);
        WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);settings.setUserAgentString(settings.getUserAgentString()+" MarshrutAndroid/1.1.6");settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptCookie(true);CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        web.addJavascriptInterface(new Downloads(),"MarshrutFiles");web.addJavascriptInterface(new Session(),"MarshrutSession");
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){Uri u=r.getUrl();if(trusted(u.toString()))return false;if("https".equals(u.getScheme())){try{startActivity(new Intent(Intent.ACTION_VIEW,u));}catch(Exception ignored){}}return true;}
            @Override public void onPageFinished(WebView v,String url){CookieManager.getInstance().flush();if(trusted(url))probeLogin();}
            @Override public void onReceivedError(WebView v,WebResourceRequest r,WebResourceError error){if(r.isForMainFrame()&&!isFinishing())new AlertDialog.Builder(MainActivity.this).setTitle("Нет связи с сервером").setMessage("Не удалось открыть "+PortalApi.ORIGIN+". Проверьте интернет или адрес сервера.").setPositiveButton("Повторить",(d,w)->web.loadUrl(PortalApi.ORIGIN)).setNeutralButton("Адрес сервера",(d,w)->changeServer()).setNegativeButton("Закрыть",null).show();}
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public boolean onShowFileChooser(WebView v,ValueCallback<Uri[]> callback,FileChooserParams params){if(fileCallback!=null)fileCallback.onReceiveValue(null);fileCallback=callback;try{startActivityForResult(params.createIntent(),10);return true;}catch(Exception e){fileCallback=null;return false;}}
        });
        web.setDownloadListener((url,agent,disposition,mime,length)->{
            if(!trusted(web.getUrl()))return;
            if(url.startsWith("blob:"+PortalApi.ORIGIN+"/"))web.evaluateJavascript("fetch("+JSONObject.quote(url)+").then(r=>r.blob()).then(b=>{if(b.size>5242880)throw Error();let f=new FileReader();f.onload=()=>MarshrutFiles.save('marshrut-export.json',String(f.result).split(',')[1]);f.readAsDataURL(b);})",null);
            else if(trusted(url))startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(url)));
        });
        if(Build.VERSION.SDK_INT>=33)registerReceiver(updates,AccountAccess.filter(),Context.RECEIVER_NOT_EXPORTED);else registerReceiver(updates,AccountAccess.filter());
        web.loadUrl(PortalApi.ORIGIN);refreshNativeState();if(Prefs.get(this).getInt("onboardingVersion",0)<2)startActivityForResult(new Intent(this,SetupActivity.class),50);
    }
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private boolean trusted(String url){return ServerOrigin.trusted(url,PortalApi.ORIGIN);}
    private final Runnable probe=new Runnable(){public void run(){if(resumed){probeLogin();main.postDelayed(this,3000);}}};
    private void probeLogin(){
        if(!trusted(web.getUrl()))return;
        web.evaluateJavascript("typeof syncAndroidSession==='function'?(syncAndroidSession(),'ready'):((typeof state!=='undefined'&&state.user)?String(state.user.id):'')",value->{
            if(value!=null&&value.matches("\"[0-9]+\""))connect(Long.parseLong(value.replace("\"","")));
        });
    }
    private void connect(long userId){
        if(!trusted(web.getUrl())||!resumed||connecting)return;
        if(Prefs.get(this).getLong("user",0)==userId&&!DeviceAuth.token().isEmpty()){startMonitoring();return;}
        stopService(new Intent(this,MonitorService.class));DeviceAuth.clear();Prefs.clearAccount(this);
        connecting=true;connectingUser=userId;connection.setText("Подключаем уведомления телефона…");
        String installation=Prefs.get(this).getString("installation","");if(installation.isEmpty()){installation=UUID.randomUUID().toString();Prefs.get(this).edit().putString("installation",installation).apply();}
        String js="fetch('/portal-api/mobile/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({installationId:"+JSONObject.quote(installation)+",deviceName:"+JSONObject.quote(Build.MANUFACTURER+" "+Build.MODEL)+",appVersion:\"1.1.6\"})}).then(async r=>{if(!r.ok)throw Error('HTTP '+r.status);return r.json();}).then(d=>MarshrutSession.connected(JSON.stringify(d))).catch(e=>MarshrutSession.failed(String(e.message)))";
        web.evaluateJavascript(js,null);
    }
    public final class Session {
        @JavascriptInterface public void openSettings(){main.post(()->{if(trusted(web.getUrl()))settings();});}
        @JavascriptInterface public void setTheme(String theme){main.post(()->{if(!trusted(web.getUrl())||(!theme.equals("dark")&&!theme.equals("light")))return;Prefs.get(MainActivity.this).edit().putString("theme",theme).apply();getWindow().setStatusBarColor(theme.equals("dark")?0xff090d16:0xfff6f8fb);getWindow().setNavigationBarColor(theme.equals("dark")?0xff090d16:0xfff6f8fb);web.setBackgroundColor(theme.equals("dark")?0xff090d16:0xfff6f8fb);root.setBackgroundColor(theme.equals("dark")?0xff090d16:0xfff6f8fb);getWindow().getDecorView().setSystemUiVisibility(theme.equals("dark")?0:View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);});}
        @JavascriptInterface public void signedIn(String userId){main.post(()->{try{connect(Long.parseLong(userId));}catch(Exception ignored){}});}
        @JavascriptInterface public void connected(String raw){main.post(()->{
            if(!trusted(web.getUrl())||!connecting)return;
            try{JSONObject data=new JSONObject(raw);if(data.getLong("userId")!=connectingUser||!data.getString("token").matches("[A-Za-z0-9_-]{43}"))throw new Exception();
                DeviceAuth.save(data.getString("token"));Prefs.get(MainActivity.this).edit().putLong("user",connectingUser).putString("cursor",Long.toString(data.getLong("cursor"))).remove("connectionError").remove("accessRevoked").apply();connecting=false;PushRegistration.ensure(MainActivity.this,true);startMonitoring();checkUpdates();refreshNativeState();
            }catch(Exception e){connecting=false;connection.setText("Не удалось сохранить подключение телефона. Повторите вход.");}
        });}
        @JavascriptInterface public void failed(String reason){main.post(()->{connecting=false;connection.setText("Не удалось подключить уведомления: "+reason+". Обновите сервер и повторите вход.");});}
        @JavascriptInterface public void signedOut(){main.post(()->{if(!trusted(web.getUrl()))return;connecting=false;String credential=DeviceAuth.token();stopService(new Intent(MainActivity.this,MonitorService.class));DeviceAuth.clear();Prefs.clearAccount(MainActivity.this);sendBroadcast(new Intent(MonitorService.UPDATE).setPackage(getPackageName()));if(!credential.isEmpty())new Thread(()->{try{PortalApi.call("mobile/disconnect",true,credential);}catch(Exception ignored){}},"disconnect").start();refreshNativeState();});}
    }

    private void checkUpdates(){if(!updateChecked&&!DeviceAuth.token().isEmpty()){updateChecked=true;AppUpdater.check(this,false);}}
    private void changeServer(){
        EditText input=new EditText(this);input.setSingleLine();input.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_VARIATION_URI);input.setText(PortalApi.ORIGIN);
        new AlertDialog.Builder(this).setTitle("Адрес сервера").setMessage("Укажите HTTPS-адрес портала. При смене сервера потребуется войти заново.").setView(input).setPositiveButton("Сохранить",(d,w)->{
            try{String next=ServerOrigin.normalize(input.getText().toString());if(next.equals(PortalApi.ORIGIN))return;
                stopService(new Intent(this,MonitorService.class));PortalApi.cancelWait();DeviceAuth.clear();Prefs.clearAccount(this);Prefs.get(this).edit().putString("serverOrigin",next).commit();PortalApi.init(this);connecting=false;openSyncRequested=false;updateChecked=false;
                CookieManager.getInstance().removeAllCookies(done->{CookieManager.getInstance().flush();web.clearHistory();web.loadUrl(PortalApi.ORIGIN);});
            }catch(Exception e){Toast.makeText(this,"Укажите HTTPS-адрес без пути, например https://logist45.ru",Toast.LENGTH_LONG).show();}
        }).setNegativeButton("Отмена",null).show();
    }
    private void startMonitoring(){
        if(DeviceAuth.token().isEmpty())return;
        AccountAccess.heartbeat(this,resumed);PushRegistration.ensure(this,false);
        if(!Prefs.enabled(this))return;
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED){
            if(!permissionAsked){permissionAsked=true;new AlertDialog.Builder(this).setTitle("Уведомления о заявках").setMessage("Разрешите уведомления, чтобы получать заявки и ошибки при свёрнутом приложении. Фоновая связь видна постоянным уведомлением; звук заявки повторяется до ОК.").setPositiveButton("Разрешить",(d,w)->requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},20)).setNegativeButton("Позже",null).show();}return;
        }
        if(Prefs.get(this).getBoolean("pushReady",false)){if(!openSyncRequested){openSyncRequested=true;try{startForegroundService(new Intent(this,MonitorService.class).setAction("PUSH"));}catch(Exception ignored){}}return;}
        if(!Prefs.get(this).getBoolean("running",false)||System.currentTimeMillis()-Prefs.get(this).getLong("lastAttempt",0)>45000){try{startForegroundService(new Intent(this,MonitorService.class).setAction("REFRESH"));}catch(Exception e){connection.setText("Не удалось включить фон. Откройте настройки приложения.");}}
        if(resumed&&!batteryExempt()&&!Prefs.get(this).getBoolean("batteryPrompt101",false)){Prefs.get(this).edit().putBoolean("batteryPrompt101",true).apply();requestBatteryExemption();}
    }
    private boolean batteryExempt(){return ((PowerManager)getSystemService(POWER_SERVICE)).isIgnoringBatteryOptimizations(getPackageName());}
    private void requestBatteryExemption(){new AlertDialog.Builder(this).setTitle("Уведомления при выключенном экране").setMessage("Разрешите фоновую работу без оптимизации батареи. Без этого Android может приостановить интернет при блокировке экрана. Во время смены расход батареи увеличится.").setPositiveButton("Разрешить",(d,w)->{try{startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,Uri.parse("package:"+getPackageName())));}catch(Exception e){startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));}}).setNegativeButton("Позже",null).show();}
    private void refreshNativeState(){
        if(connection==null)return;
        long last=Prefs.get(this).getLong("lastSync",0);
        String failure=Prefs.get(this).getString("connectionError","");
        connection.setText(!failure.isEmpty()?failure:!Prefs.enabled(this)?"Фоновые уведомления выключены":!getSystemService(NotificationManager.class).areNotificationsEnabled()?"Разрешите уведомления в настройках Android":last==0?"Войдите в кабинет для фоновой связи":Prefs.get(this).getString("bot","Подключение…")+" · связь "+(System.currentTimeMillis()-last<45000?"есть":"ожидается"));
        if(Prefs.enabled(this)&&!Prefs.get(this).getBoolean("pushReady",false)&&!batteryExempt())connection.append(" · батарея ограничивает фон (⋯)");
        if(Prefs.enabled(this)&&failure.isEmpty()&&Prefs.get(this).getBoolean("pushReady",false))connection.setText("FCM подключён · уведомления включены");
        if(resumed&&!alertOpen&&last>=openedAt&&Prefs.enabled(this)&&getSystemService(NotificationManager.class).areNotificationsEnabled()){try{JSONArray queue=new JSONArray(Prefs.get(this).getString("queue","[]"));for(int i=0;i<queue.length();i++){long id=queue.getJSONObject(i).getLong("id");if(!Prefs.acknowledged(this,id)){alertOpen=true;startActivityForResult(new Intent(this,AlertActivity.class).putExtra("id",id),30);break;}}}catch(Exception ignored){}}
    }
    private void settings(){
        String[] choices={Prefs.enabled(this)?"Выключить фоновую связь":"Включить фоновую связь","Разрешения и звуки Android","Работа без ограничений батареи","О приложении","Настроить разрешения","Состояние подключения","Проверить обновление","Адрес сервера"};
        new AlertDialog.Builder(this).setTitle("Настройки приложения").setItems(choices,(d,which)->{
            if(which==6)AppUpdater.check(this,true);
            if(which==7)changeServer();
            if(which==0){boolean enable=!Prefs.enabled(this);Prefs.get(this).edit().putBoolean("enabled",enable).apply();PushRegistration.ensure(this,true);if(enable){openSyncRequested=false;permissionAsked=false;startMonitoring();}else stopService(new Intent(this,MonitorService.class));refreshNativeState();}
            if(which==1)startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,getPackageName()));
            if(which==2){if(!batteryExempt())requestBatteryExemption();else new AlertDialog.Builder(this).setTitle("Фон разрешён").setMessage("Исключение из оптимизации батареи включено. На Xiaomi, Honor и других устройствах дополнительно проверьте автозапуск и разрешение фоновой сети в настройках приложения.").setPositiveButton("Настройки телефона",(d2,w)->startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName())))).setNegativeButton("Закрыть",null).show();}
            if(which==4)startActivityForResult(new Intent(this,SetupActivity.class),50);
            if(which==5){refreshNativeState();connection.append("\n"+(Prefs.enabled(this)?Prefs.get(this).getString("pushStatus","FCM: регистрация ожидается"):"Доставка отключена пользователем. Регистрация FCM сохранена."));}if(which==5)new AlertDialog.Builder(this).setTitle("Подключение").setMessage(connection.getText()).setPositiveButton("ОК",null).show();
            if(which==3)new AlertDialog.Builder(this).setTitle("Маршрут 1.1.6").setMessage("Все функции портала + системные уведомления Android. Сервер: logist45.ru. События доставляются через Firebase FCM. Пока отправка FCM не настроена на сервере, используется резервная фоновая связь. При отсутствии сети доставка задерживается. После принудительной остановки или перезагрузки откройте приложение снова. Изменить личный сигнал можно в профиле портала.").setPositiveButton("ОК",null).show();
        }).show();
    }
    public final class Downloads {
        @JavascriptInterface public void save(String name,String base64){
            if(base64==null||base64.length()>7*1024*1024)return;
            main.post(()->{if(!trusted(web.getUrl()))return;try{download=android.util.Base64.decode(base64,android.util.Base64.DEFAULT);if(download.length>5*1024*1024){download=null;return;}Intent save=new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/json").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE,"marshrut-export.json");startActivityForResult(save,11);}catch(Exception e){download=null;}});
        }
    }
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results){super.onRequestPermissionsResult(request,permissions,results);if(request==20&&results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED)startMonitoring();checkUpdates();refreshNativeState();}
    @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request==10&&fileCallback!=null){fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result,data));fileCallback=null;}if(request==11){if(result==RESULT_OK&&data!=null&&download!=null)try(OutputStream out=getContentResolver().openOutputStream(data.getData())){out.write(download);Toast.makeText(this,"Файл сохранён",Toast.LENGTH_SHORT).show();}catch(Exception e){Toast.makeText(this,"Не удалось сохранить файл",Toast.LENGTH_LONG).show();}download=null;}if(request==61&&getPackageManager().canRequestPackageInstalls())AppUpdater.install(this);if(request==50){permissionAsked=true;probeLogin();}if(request==30){alertOpen=false;main.postDelayed(this::refreshNativeState,1500);}}
    @Override protected void onResume(){super.onResume();resumed=true;checkUpdates();AccountAccess.heartbeat(this,true);if(Prefs.get(this).getBoolean("accessRevoked",false))web.loadUrl(PortalApi.ORIGIN);main.post(probe);refreshNativeState();}
    @Override protected void onPause(){resumed=false;AccountAccess.heartbeat(this,false);openSyncRequested=false;main.removeCallbacks(probe);CookieManager.getInstance().flush();super.onPause();}
    @Override public void onBackPressed(){if(!Prefs.get(this).getBoolean("accessRevoked",false)&&web.canGoBack())web.goBack();else moveTaskToBack(true);}
    @Override protected void onDestroy(){unregisterReceiver(updates);main.removeCallbacksAndMessages(null);if(fileCallback!=null)fileCallback.onReceiveValue(null);web.removeJavascriptInterface("MarshrutFiles");web.removeJavascriptInterface("MarshrutSession");web.destroy();super.onDestroy();}
}
