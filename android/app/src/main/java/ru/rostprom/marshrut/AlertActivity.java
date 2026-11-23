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
            LinearLayout layout=new LinearLayout(this);layout.setOrientation(LinearLayout.VERTICAL);layout.setPadding(dp(24),dp(16),dp(24),dp(16));
            TextView title=new TextView(this);title.setText(p.optBoolean("test")?"Тест уведомления":p.optBoolean("observed")?"Найдена заявка":"Заявка взята в работу");title.setTextSize(22);title.setTextColor(0xff10243a);layout.addView(title);
            TextView details=new TextView(this);details.setTextSize(16);details.setPadding(0,dp(20),0,dp(20));
            String date=p.optString("carDt","—");try{date=java.time.OffsetDateTime.parse(date).atZoneSameInstant(java.time.ZoneId.of("Asia/Yekaterinburg")).format(java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm"));}catch(Exception ignored){}
            details.setText("Заявка WB: "+p.optString("id")+"\nПлан: №"+p.optString("planId")+"\nМаршрут: "+p.optString("routeId")+" "+p.optString("routeName")+"\nПодача (Екатеринбург): "+date+"\nВодитель: "+p.optString("driver")+"\nАвтомобиль: "+p.optString("vehicle")+(p.isNull("trailer")?"":"\nПрицеп: "+p.optString("trailer"))+"\n\n"+p.optString("message"));layout.addView(details);
            Button ok=new Button(this);ok.setText("ОК · подтверждаю");layout.addView(ok);ok.setOnClickListener(v->{startService(new Intent(this,MonitorService.class).setAction("ACK").putExtra("id",id));finish();});
            ScrollView scroll=new ScrollView(this);scroll.addView(layout);setContentView(scroll);
        }catch(Exception e){finish();}
    }
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    @Override public void onBackPressed(){/* Explicit acknowledgement is required. */}
}
