package ru.rostprom.marshrut;
import android.content.Context;
import android.security.keystore.*;
import android.util.Base64;
import java.security.KeyStore;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;

// A revocable portal device credential, not a WB token or the employee's password.
final class DeviceAuth {
    private static Context context;
    static void init(Context c){context=c.getApplicationContext();PortalApi.init(context);}
    private static javax.crypto.SecretKey key() throws Exception {
        KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);
        if(!ks.containsAlias("MarshrutDevice")){KeyGenerator generator=KeyGenerator.getInstance("AES","AndroidKeyStore");generator.init(new KeyGenParameterSpec.Builder("MarshrutDevice",KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());generator.generateKey();}
        return (javax.crypto.SecretKey)ks.getKey("MarshrutDevice",null);
    }
    static synchronized void save(String token) throws Exception {
        Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());
        Prefs.get(context).edit().putString("deviceSecret",Base64.encodeToString(c.doFinal(token.getBytes("UTF-8")),Base64.NO_WRAP)).putString("deviceIv",Base64.encodeToString(c.getIV(),Base64.NO_WRAP)).commit();
    }
    static synchronized String token(){
        try{String data=Prefs.get(context).getString("deviceSecret","");if(data.isEmpty())return "";Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(Prefs.get(context).getString("deviceIv",""),Base64.NO_WRAP)));return new String(c.doFinal(Base64.decode(data,Base64.NO_WRAP)),"UTF-8");}catch(Exception e){clear();return "";}
    }
    static synchronized void clear(){if(context!=null)Prefs.get(context).edit().remove("deviceSecret").remove("deviceIv").apply();}
}
