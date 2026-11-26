package ru.rostprom.marshrut;
import org.junit.Test;
import static org.junit.Assert.*;
public class ServerOriginTest {
 @Test public void normalizesHttpsHost(){assertEquals("https://logist45.ru",ServerOrigin.normalize(" https://LOGIST45.ru:443/ "));}
 @Test public void changingServerChangesTrustedBridgeHost(){assertTrue(ServerOrigin.trusted("https://open-key.ru/portal-api/session","https://open-key.ru"));assertFalse(ServerOrigin.trusted("https://open-key.ru/","https://logist45.ru"));assertTrue(ServerOrigin.trusted("https://logist45.ru/path?q=1","https://logist45.ru"));}
 @Test public void rejectsUnsafeServerAddresses(){for(String bad:new String[]{"http://logist45.ru","https://user@logist45.ru","https://logist45.ru/path","https://logist45.ru?q=1","https://logist45.ru#x","https://logist45.ru:444"}){try{ServerOrigin.normalize(bad);fail(bad);}catch(IllegalArgumentException expected){}}}
 @Test public void untrustedPagesCannotUseBridge(){for(String bad:new String[]{"https://logist45.ru.evil.test/","https://user@logist45.ru","http://logist45.ru","https://logist45.ru:444",null})assertFalse(ServerOrigin.trusted(bad,"https://logist45.ru"));}
 @Test public void legacyServerAutomaticallyMigrates(){assertEquals("https://logist45.ru",ServerOrigin.migrateLegacy("https://open-key.ru"));assertEquals("https://logist45.ru",ServerOrigin.migrateLegacy("https://www.open-key.ru/"));assertEquals("https://logist45.ru",ServerOrigin.migrateLegacy(null));}
 @Test public void currentOrCustomServerIsPreserved(){assertEquals("https://logist45.ru",ServerOrigin.migrateLegacy("https://logist45.ru"));assertEquals("https://private.example",ServerOrigin.migrateLegacy("https://private.example"));}
}
