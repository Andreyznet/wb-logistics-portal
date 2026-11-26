package ru.rostprom.marshrut;
import java.net.URI;
import java.util.Locale;
final class ServerOrigin {
 static final String DEFAULT="https://logist45.ru";
 static String migrateLegacy(String input){if(input==null||input.isEmpty())return DEFAULT;String origin=normalize(input);return origin.equals("https://open-key.ru")||origin.equals("https://www.open-key.ru")?DEFAULT:origin;}

 static String normalize(String input){try{URI u=new URI(input.trim());if(!"https".equalsIgnoreCase(u.getScheme())||u.getHost()==null||u.getUserInfo()!=null||u.getQuery()!=null||u.getFragment()!=null||u.getPort()!=-1&&u.getPort()!=443||u.getPath()!=null&&!u.getPath().isEmpty()&&!u.getPath().equals("/"))throw new IllegalArgumentException();return "https://"+u.getHost().toLowerCase(Locale.ROOT);}catch(Exception e){throw new IllegalArgumentException("Invalid server origin");}}
 static boolean trusted(String url,String origin){try{URI u=new URI(url),o=new URI(normalize(origin));return "https".equalsIgnoreCase(u.getScheme())&&u.getUserInfo()==null&&o.getHost().equalsIgnoreCase(u.getHost())&&(u.getPort()==-1||u.getPort()==443);}catch(Exception e){return false;}}
}
