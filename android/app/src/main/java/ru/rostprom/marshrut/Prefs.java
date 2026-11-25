package ru.rostprom.marshrut;
import android.content.*;
import java.util.*;
import org.json.*;
final class Prefs {
    static android.content.SharedPreferences get(Context c){return c.getSharedPreferences("dispatch",Context.MODE_PRIVATE);}
    static boolean enabled(Context c){return get(c).getBoolean("enabled",true);}
    private static AlertReceiptState receipts(Context c){return new AlertReceiptState(get(c).getStringSet("acks",Collections.emptySet()),get(c).getStringSet("dismissed",Collections.emptySet()));}
    static synchronized boolean acknowledged(Context c,long id){return receipts(c).hides(Long.toString(id));}
    private static JSONArray filter(JSONArray source,AlertReceiptState state){JSONArray result=new JSONArray();for(int i=0;i<source.length();i++){JSONObject row=source.optJSONObject(i);if(row!=null&&!state.hides(Long.toString(row.optLong("id"))))result.put(row);}return result;}
    static synchronized JSONArray visibleQueue(Context c,JSONArray source){return filter(source,receipts(c));}
    static synchronized JSONArray saveQueue(Context c,JSONArray source){JSONArray queue=visibleQueue(c,source);get(c).edit().putString("queue",queue.toString()).apply();return queue;}
    static synchronized boolean acknowledge(Context c,long id){
        if(id<=0)return false;AlertReceiptState state=receipts(c).acknowledge(Long.toString(id));JSONArray queue;
        try{queue=new JSONArray(get(c).getString("queue","[]"));}catch(JSONException e){queue=new JSONArray();}
        return get(c).edit().putStringSet("acks",state.pending).putStringSet("dismissed",state.dismissed).putString("queue",filter(queue,state).toString()).commit();
    }
    static synchronized void confirm(Context c,String id){AlertReceiptState state=receipts(c).confirmed(id);get(c).edit().putStringSet("acks",state.pending).putStringSet("dismissed",state.dismissed).commit();}
    static synchronized void clearAccount(Context c){get(c).edit().remove("pushReady").remove("pushStatus").remove("user").remove("cursor").remove("revision").remove("bot").remove("queue").remove("acks").remove("dismissed").remove("lastEvent").remove("lastSync").apply();}
}
