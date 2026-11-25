package ru.rostprom.marshrut;
import android.app.*;
import android.os.Bundle;
import android.content.*;
import android.os.Build;
import android.widget.*;
import org.json.*;

public final class AlertActivity extends Activity {
    private long id;private boolean registered=false;private final BroadcastReceiver access=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){if(AccountAccess.REVOKED.equals(i.getAction())||DeviceAuth.token().isEmpty())finish();}};
    @Override public void onCreate(Bundle state){super.onCreate(state);if(Build.VERSION.SDK_INT>=33)registerReceiver(access,AccountAccess.filter(),Context.RECEIVER_NOT_EXPORTED);else registerReceiver(access,AccountAccess.filter());registered=true;setFinishOnTouchOutside(false);id=getIntent().getLongExtra("id",0);
        try{
            JSONArray queue=new JSONArray(Prefs.get(this).getString("queue","[]"));JSONObject alert=null;
            for(int i=0;i<queue.length();i++)if(queue.getJSONObject(i).getLong("id")==id)alert=queue.getJSONObject(i);
            if(alert==null||Prefs.acknowledged(this,id)){finish();return;}JSONObject p=alert.getJSONObject("payload");
            setContentView(new AlertCard(this,p,()->{if(!Prefs.acknowledge(this,id)){Toast.makeText(this,"Не удалось сохранить подтверждение. Повторите ОК.",Toast.LENGTH_LONG).show();return;}ReceiptJob.schedule(this);try{startService(new Intent(this,MonitorService.class).setAction("ACK").putExtra("id",id));}catch(Exception ignored){}finish();}));
            getWindow().setBackgroundDrawableResource(android.R.color.transparent);
            android.view.WindowManager.LayoutParams attrs=getWindow().getAttributes();attrs.dimAmount=0.65f;getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND);getWindow().setAttributes(attrs);
            getWindow().setLayout(Math.min(dp(560),getResources().getDisplayMetrics().widthPixels-dp(32)),android.view.WindowManager.LayoutParams.WRAP_CONTENT);
        }catch(Exception e){finish();}
    }
    @Override protected void onResume(){super.onResume();AccountAccess.heartbeat(this,true);if(DeviceAuth.token().isEmpty()||Prefs.acknowledged(this,id))finish();}
    @Override protected void onPause(){AccountAccess.heartbeat(this,false);super.onPause();}
    @Override protected void onDestroy(){if(registered)unregisterReceiver(access);super.onDestroy();}
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    @Override public void onBackPressed(){/* Explicit acknowledgement is required. */}
}
