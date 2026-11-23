package ru.rostprom.marshrut;
import android.content.*;
final class Prefs {
    static android.content.SharedPreferences get(Context c){return c.getSharedPreferences("dispatch",Context.MODE_PRIVATE);}
    static boolean enabled(Context c){return get(c).getBoolean("enabled",true);}
    static void clearAccount(Context c){get(c).edit().remove("user").remove("cursor").remove("revision").remove("bot").remove("queue").remove("acks").remove("lastEvent").remove("lastSync").apply();}
}
