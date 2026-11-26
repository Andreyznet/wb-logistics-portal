package ru.rostprom.marshrut;

import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;

final class PortalApi {
    static volatile String ORIGIN="https://logist45.ru";
    static void init(android.content.Context c){ORIGIN=Prefs.get(c).getString("serverOrigin","https://logist45.ru");}
    private static volatile HttpURLConnection waiting;
    static final class WaitCancelled extends IOException {}
    static void cancelWait(){HttpURLConnection current=waiting;waiting=null;if(current!=null)new Thread(current::disconnect,"cancel-wait").start();}
    static class ApiException extends IOException { final int status; ApiException(int s){super("HTTP "+s);status=s;} }
    static JSONObject call(String path, boolean post) throws Exception {
        return call(path,post,DeviceAuth.token());
    }
    static JSONObject call(String path, boolean post,String credential) throws Exception {
        return request(path,post,credential,null);
    }
    static JSONObject post(String path,JSONObject body) throws Exception {return request(path,true,DeviceAuth.token(),body);}
    static JSONObject post(String path,JSONObject body,String credential) throws Exception {return request(path,true,credential,body);}
    private static JSONObject request(String path,boolean post,String credential,JSONObject body) throws Exception {
        String origin=ORIGIN;if(credential.isEmpty()||!path.equals("mobile/disconnect")&&!credential.equals(DeviceAuth.token()))throw new ApiException(401);
        HttpURLConnection c=(HttpURLConnection)new URL(origin+"/portal-api/"+path).openConnection();
        boolean longWait=path.contains("wait=25");if(longWait)waiting=c;
        try {
            c.setInstanceFollowRedirects(false);c.setConnectTimeout(12000);c.setReadTimeout(longWait?35000:15000);
            c.setRequestProperty("Accept","application/json");
            if(credential.isEmpty())throw new ApiException(401);
            c.setRequestProperty("Authorization","Bearer "+credential);
            if(post){c.setRequestMethod("POST");c.setRequestProperty("Origin",origin);c.setRequestProperty("Content-Type","application/json");c.setDoOutput(true);try(OutputStream out=c.getOutputStream()){out.write((body==null?"{}":body.toString()).getBytes(StandardCharsets.UTF_8));}}
            int status=c.getResponseCode();if(status!=200)throw new ApiException(status);
            String type=c.getContentType();if(type==null||!type.contains("application/json"))throw new IOException("Сервер вернул не JSON");
            try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){
                byte[] buf=new byte[8192];int n;while((n=in.read(buf))!=-1){if(out.size()+n>4*1024*1024)throw new IOException("Слишком большой ответ");out.write(buf,0,n);}
                return new JSONObject(out.toString("UTF-8"));
            }
        }catch(IOException e){if(longWait&&waiting!=c)throw new WaitCancelled();throw e;}finally{if(waiting==c)waiting=null;c.disconnect();}
    }
}
