package ru.rostprom.marshrut;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.*;
import android.widget.*;
import org.json.JSONObject;

final class AlertCard extends LinearLayout {
    private final int ink,muted,line;
    AlertCard(Context c,JSONObject p,Runnable acknowledge){super(c);
        boolean dark=Prefs.get(c).getString("theme","light").equals("dark");
        ink=Color.parseColor(dark?"#F1F5FA":"#10243A");muted=Color.parseColor(dark?"#97A7BC":"#65788D");line=Color.parseColor(dark?"#253044":"#DFE6EF");
        setOrientation(VERTICAL);setPadding(dp(24),dp(24),dp(24),dp(24));setBackground(shape(dark?0xff101724:Color.WHITE,20));
        TextView mark=text(p.optBoolean("acceptanceError")?"!":"✓",28,p.optBoolean("acceptanceError")?0xffdc3545:0xff00a978,true);mark.setGravity(Gravity.CENTER);mark.setBackground(shape(dark?0xff12352f:0xffe7f7f0,16));addView(mark,new LayoutParams(dp(52),dp(52)));
        TextView title=text(p.optBoolean("test")?"Тест уведомления":p.optBoolean("acceptanceError")?(p.optBoolean("uncertain")?"Результат принятия неизвестен":"Не удалось взять заявку"):p.optBoolean("observed")?"Найдена заявка":"Заявка взята в работу",23,ink,true);
        LayoutParams heading=new LayoutParams(-1,-2);heading.topMargin=dp(18);heading.bottomMargin=dp(8);addView(title,heading);
        TextView subtitle=text(p.optBoolean("test")?"Проверка окна и звука. Запрос принятия в WB не отправлялся.":p.optBoolean("acceptanceError")?p.optString("message")+(p.optBoolean("uncertain")?" Повторное принятие заблокировано до проверки результата.":" Проверьте заявку в WB."):p.optBoolean("observed")?"Режим «Не брать в работу»: заявка найдена, принятие не отправлялось.":"Назначение экипажа подтверждено. Проверьте данные рейса.",13,muted,false);subtitle.setLineSpacing(dp(3),1);addView(subtitle);
        int maxBody=Math.max(dp(80),getResources().getDisplayMetrics().heightPixels-dp(400));
        ScrollView body=new ScrollView(c){@Override protected void onMeasure(int w,int h){super.onMeasure(w,MeasureSpec.makeMeasureSpec(MeasureSpec.getMode(h)==MeasureSpec.UNSPECIFIED?maxBody:Math.min(maxBody,MeasureSpec.getSize(h)),MeasureSpec.AT_MOST));}};
        LinearLayout rows=new LinearLayout(c);rows.setOrientation(VERTICAL);body.addView(rows);
        row(rows,"Заявка WB / план",p.optString("id")+" / №"+p.optString("planId"));
        row(rows,"Маршрут",p.optString("routeId")+(p.optString("routeName").isEmpty()?"":"\n"+p.optString("routeName")));
        String date=p.optString("carDt","—");try{date=java.time.OffsetDateTime.parse(date).atZoneSameInstant(java.time.ZoneId.of("Asia/Yekaterinburg")).format(java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm"));}catch(Exception ignored){}
        row(rows,"Подача",date);row(rows,"Водитель",p.optString("driver"));row(rows,"Автомобиль",p.optString("vehicle"));if(!p.isNull("trailer")&&!p.optString("trailer").isEmpty())row(rows,"Прицеп",p.optString("trailer"));
        LayoutParams content=new LayoutParams(-1,-2);content.topMargin=dp(18);addView(body,content);
        Button ok=new Button(c);ok.setText("Ок");ok.setAllCaps(false);ok.setTextSize(16);ok.setTypeface(null,Typeface.BOLD);ok.setTextColor(Color.WHITE);ok.setBackground(shape(0xffe45400,12));ok.setStateListAnimator(null);
        LayoutParams button=new LayoutParams(-1,dp(50));button.topMargin=dp(20);addView(ok,button);ok.setOnClickListener(v->acknowledge.run());
    }
    private TextView text(String value,int size,int color,boolean bold){TextView view=new TextView(getContext());view.setText(value);view.setTextSize(size);view.setTextColor(color);view.setTypeface(Typeface.create("sans-serif",bold?Typeface.BOLD:Typeface.NORMAL));return view;}
    private GradientDrawable shape(int color,int radius){GradientDrawable bg=new GradientDrawable();bg.setColor(color);bg.setCornerRadius(dp(radius));return bg;}
    private void row(LinearLayout parent,String label,String value){View border=new View(getContext());border.setBackgroundColor(line);parent.addView(border,new LayoutParams(-1,dp(1)));LinearLayout r=new LinearLayout(getContext());r.setGravity(Gravity.TOP);r.setPadding(0,dp(13),0,dp(13));TextView left=text(label,12,muted,false),right=text(value,14,ink,false);right.setGravity(Gravity.END);right.setLineSpacing(dp(3),1);r.addView(left,new LayoutParams(dp(104),-2));r.addView(right,new LayoutParams(0,-2,1));parent.addView(r);}
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
}
