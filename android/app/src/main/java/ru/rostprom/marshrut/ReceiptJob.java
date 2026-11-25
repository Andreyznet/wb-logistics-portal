package ru.rostprom.marshrut;
import android.app.job.*;
import android.content.*;
import java.util.*;

public final class ReceiptJob extends JobService {
    static void schedule(Context c){((JobScheduler)c.getSystemService(Context.JOB_SCHEDULER_SERVICE)).schedule(new JobInfo.Builder(7002,new ComponentName(c,ReceiptJob.class)).setPersisted(true).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setBackoffCriteria(30000,JobInfo.BACKOFF_POLICY_EXPONENTIAL).build());}
    static synchronized boolean flush(Context c,String credential) throws Exception {
        int count=0;for(String id:new HashSet<>(Prefs.get(c).getStringSet("acks",Collections.emptySet()))){
            if(!credential.equals(DeviceAuth.token()))return true;if(count++>=25)return false;
            try{PortalApi.call("mobile/alerts/"+id+"/ack",true,credential);}catch(PortalApi.ApiException e){if(e.status!=404)throw e;}
            synchronized(Prefs.class){if(!credential.equals(DeviceAuth.token()))return true;Prefs.confirm(c,id);}
        }
        return Prefs.get(c).getStringSet("acks",Collections.emptySet()).isEmpty();
    }
    @Override public boolean onStartJob(JobParameters params){new Thread(()->{
        DeviceAuth.init(this);String credential=DeviceAuth.token();if(credential.isEmpty()){jobFinished(params,false);return;}
        try{jobFinished(params,!flush(this,credential));}catch(PortalApi.ApiException e){if(e.status==401)AccountAccess.revoke(this,credential);jobFinished(params,e.status!=401);}catch(Exception e){jobFinished(params,true);}
    },"alert-receipts").start();return true;}
    @Override public boolean onStopJob(JobParameters params){return true;}
}
