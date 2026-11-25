package ru.rostprom.marshrut;
import org.junit.Test;
import static org.junit.Assert.*;
import java.util.*;

public class AlertReceiptStateTest {
    @Test public void acknowledgementRemainsHiddenAfterServerConfirmation(){
        AlertReceiptState before=new AlertReceiptState(Collections.emptySet(),Collections.emptySet());
        AlertReceiptState offline=before.acknowledge("42");assertTrue(offline.hides("42"));assertTrue(offline.pending.contains("42"));assertFalse(before.hides("42"));
        AlertReceiptState confirmed=offline.confirmed("42");assertTrue(confirmed.hides("42"));assertFalse(confirmed.pending.contains("42"));assertFalse(confirmed.hides("43"));assertTrue(confirmed.acknowledge("42").pending.isEmpty());
    }
    @Test public void staleResponsesAndProcessRestartCannotResurrectAcknowledgedAlert(){
        AlertReceiptState state=new AlertReceiptState(Collections.emptySet(),Collections.emptySet()).acknowledge("10").confirmed("10");
        AlertReceiptState restored=new AlertReceiptState(state.pending,state.dismissed);assertTrue(restored.hides("10"));assertFalse(restored.hides("11"));
    }
    @Test public void confirmationDoesNotLoseNewAcknowledgements(){
        AlertReceiptState state=new AlertReceiptState(Collections.emptySet(),Collections.emptySet()).acknowledge("10").acknowledge("11").confirmed("10");
        assertTrue(state.pending.contains("11"));assertFalse(state.pending.contains("10"));assertTrue(state.hides("10"));assertTrue(state.hides("11"));
    }
    @Test public void legacyPendingReceiptsAreHiddenBeforeTheyReachServer(){
        AlertReceiptState restored=new AlertReceiptState(Collections.singleton("77"),Collections.emptySet());assertTrue(restored.hides("77"));assertTrue(restored.confirmed("77").hides("77"));
    }
}
