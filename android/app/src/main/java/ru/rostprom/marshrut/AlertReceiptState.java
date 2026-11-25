package ru.rostprom.marshrut;
import java.util.*;

// A successful server receipt removes pending work, never the local dismissal.
final class AlertReceiptState {
    final Set<String> pending,dismissed;
    AlertReceiptState(Collection<String> pending,Collection<String> dismissed){this.pending=new HashSet<>(pending);this.dismissed=new HashSet<>(dismissed);this.dismissed.addAll(pending);}
    AlertReceiptState acknowledge(String id){AlertReceiptState next=new AlertReceiptState(pending,dismissed);if(!next.dismissed.contains(id))next.pending.add(id);next.dismissed.add(id);return next;}
    AlertReceiptState confirmed(String id){AlertReceiptState next=new AlertReceiptState(pending,dismissed);next.pending.remove(id);return next;}
    boolean hides(String id){return dismissed.contains(id);}
}
