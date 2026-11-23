package ru.rostprom.marshrut;
import android.app.*;
import android.os.Bundle;
import android.content.Intent;
import android.widget.*;
import org.json.*;

public final class AlertActivity extends Activity {
    private long id;
    @Override public void onCreate(Bundle state){super.onCreate(state);setFinishOnTouchOutside(false);id=getIntent().getLongExtra("id",0);
        try{
            JSONArray queue=new JSONArray(Prefs.get(this).getString("queue","[]"));JSONObject alert=null;
            for(int i=0;i<queue.length();i++)if(queue.getJSONObject(i).getLong("id")==id)alert=queue.getJSONObject(i);
            if(alert==null){finish();return;}JSONObject p=alert.getJSONObject("payload");
            setContentView(new AlertCard(this,p,()->{startService(new Intent(this,MonitorService.class).setAction("ACK").putExtra("id",id));finish();}));
            getWindow().setBackgroundDrawableResource(android.R.color.transparent);
            android.view.WindowManager.LayoutParams attrs=getWindow().getAttributes();attrs.dimAmount=0.65f;getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND);getWindow().setAttributes(attrs);
            getWindow().setLayout(Math.min(dp(560),getResources().getDisplayMetrics().widthPixels-dp(32)),android.view.WindowManager.LayoutParams.WRAP_CONTENT);
        }catch(Exception e){finish();}
    }
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    @Override public void onBackPressed(){/* Explicit acknowledgement is required. */}
}
