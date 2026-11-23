package ru.rostprom.marshrut;
import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.widget.*;

public final class SetupActivity extends Activity {
    private TextView status;private Button next;private boolean askedNotifications=false,askedBattery=false;
    @Override public void onCreate(Bundle state){super.onCreate(state);
        LinearLayout page=new LinearLayout(this);page.setOrientation(LinearLayout.VERTICAL);page.setGravity(Gravity.CENTER_VERTICAL);page.setPadding(dp(28),dp(40),dp(28),dp(40));page.setBackgroundColor(0xfff6f8fb);
        TextView brand=text("маршрут",22,0xffe45400,true);page.addView(brand);
        TextView title=text("Настроим уведомления",28,0xff10243a,true);title.setPadding(0,dp(28),0,dp(12));page.addView(title);
        TextView explanation=text("Разрешите уведомления, чтобы получать заявки и события бота при выключенном экране. После входа телефон зарегистрируется в Firebase FCM. Для push необходимы Google Play services и интернет.",16,0xff65788d,false);explanation.setLineSpacing(dp(4),1);page.addView(explanation);
        status=text("",16,0xff10243a,false);status.setPadding(0,dp(28),0,dp(28));status.setLineSpacing(dp(12),1);page.addView(status);
        next=new Button(this);next.setTextColor(Color.WHITE);next.setAllCaps(false);next.setTextSize(16);GradientDrawable bg=new GradientDrawable();bg.setColor(0xffe45400);bg.setCornerRadius(dp(12));next.setBackground(bg);next.setStateListAnimator(null);page.addView(next,new LinearLayout.LayoutParams(-1,dp(52)));next.setOnClickListener(v->advance());
        TextView note=text("При отказе приложение останется доступным, но фоновые оповещения могут не работать. Позже разрешения можно изменить в профиле → «Настройки приложения». Камера, контакты и доступ ко всем файлам не запрашиваются.",13,0xff65788d,false);note.setPadding(0,dp(20),0,0);note.setLineSpacing(dp(3),1);page.addView(note);
        ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);scroll.addView(page);setContentView(scroll);refresh();
    }
    private boolean notifications(){return getSystemService(NotificationManager.class).areNotificationsEnabled()&&(Build.VERSION.SDK_INT<33||checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED);}
    private boolean battery(){return ((PowerManager)getSystemService(POWER_SERVICE)).isIgnoringBatteryOptimizations(getPackageName());}
    private void refresh(){if(status==null)return;status.setText((notifications()?"✓":"○")+" Уведомления: "+(notifications()?"разрешены":"нужно разрешить")+"\nFCM не требует постоянного опроса сервера телефоном.");next.setText(notifications()||askedNotifications?"Открыть кабинет":"Продолжить");}
    private void advance(){
        if(!notifications()&&!askedNotifications){askedNotifications=true;if(Build.VERSION.SDK_INT>=33){requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},1);return;}startActivityForResult(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,getPackageName()),2);return;}
        Prefs.get(this).edit().putInt("onboardingVersion",2).apply();finish();
    }
    @Override public void onRequestPermissionsResult(int r,String[] p,int[] result){super.onRequestPermissionsResult(r,p,result);refresh();if(r==1)advance();}
    @Override protected void onActivityResult(int r,int result,Intent data){super.onActivityResult(r,result,data);refresh();}
    @Override protected void onResume(){super.onResume();refresh();}
    private TextView text(String value,int size,int color,boolean bold){TextView t=new TextView(this);t.setText(value);t.setTextSize(size);t.setTextColor(color);t.setTypeface(null,bold?Typeface.BOLD:Typeface.NORMAL);return t;}
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
}
