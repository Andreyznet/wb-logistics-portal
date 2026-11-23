package ru.rostprom.marshrut;
import android.app.job.*;
public final class PushRegistrationJob extends JobService {
    @Override public boolean onStartJob(JobParameters params){new Thread(()->jobFinished(params,!PushRegistration.register(this)),"push-registration-job").start();return true;}
    @Override public boolean onStopJob(JobParameters params){return true;}
}
