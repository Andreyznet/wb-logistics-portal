package ru.rostprom.marshrut;
import android.app.*;
import android.os.Bundle;
import android.content.*;
import android.os.Build;
import android.widget.*;
import org.json.*;

public final class AlertActivity extends Activity {
    private long id;private boolean registered=false;private final BroadcastReceiver access=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){if(AccountAccess.REVOKED.equals(i.getAction())||DeviceAuth.token().isEmpty()){finish();return;}if(MonitorService.UPDATE.equals(i.getAction())){try{JSONArray queue=new JSONArray(Prefs.get(c).getString("queue","[]"));boolean present=false;for(int n=0;n<queue.length();n++)if(queue.getJSONObject(n).getLong("id")==id)present=true;if(!present)finish();}catch(Exception ignored){}}}};
    @Override public void onCreate(Bundle state){super.onCreate(state);IntentFilter filter=AccountAccess.filter();if(Build.VERSION.SDK_INT>=33)registerReceiver(access,filter,Context.RECEIVER_NOT_EXPORTED);else registerReceiver(access,filter);registered=true;setFinishOnTouchOutside(false);id=getIntent().getLongExtra("id",0);
        try{
            JSONArray queue=new JSONArray(Prefs.get(this).getString("queue","[]"));JSONObject alert=null;
            for(int i=0;i<queue.length();i++)if(queue.getJSONObject(i).getLong("id")==id)alert=queue.getJSONObject(i);
            if(alert==null||Prefs.acknowledged(this,id)){finish();return;}JSONObject p=alert.getJSONObject("payload");if(!p.has("acceptedAt")&&!p.optBoolean("test")&&!p.optBoolean("observed")&&!p.optBoolean("acceptanceError"))p.put("acceptedAt",alert.optString("created_at"));
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
