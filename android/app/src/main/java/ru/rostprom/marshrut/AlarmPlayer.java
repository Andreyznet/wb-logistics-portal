package ru.rostprom.marshrut;
import android.content.Context;
import android.media.*;
import android.os.*;
final class AlarmPlayer {
    private MediaPlayer player;private Vibrator vibrator;private String active="";
    synchronized void play(Context c,String key,String sound,int volume){
        if(key.equals(active))return;stop();active=key;
        try {
            int resource=c.getResources().getIdentifier(sound.replace('-','_'),"raw",c.getPackageName());
            if(resource==0)resource=R.raw.pulse_alarm;
            player=new MediaPlayer();player.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            try(android.content.res.AssetFileDescriptor fd=c.getResources().openRawResourceFd(resource)){player.setDataSource(fd.getFileDescriptor(),fd.getStartOffset(),fd.getLength());}
            player.setLooping(true);float level=Math.max(0.1f,Math.min(1f,volume/100f));player.setVolume(level,level);player.prepare();player.start();
            vibrator=(Vibrator)c.getSystemService(Context.VIBRATOR_SERVICE);if(vibrator!=null)vibrator.vibrate(VibrationEffect.createWaveform(new long[]{0,500,700},0));
        }catch(Exception ignored){/* System notification remains available even if playback fails. */}
    }
    synchronized void stop(){if(player!=null){try{player.stop();}catch(Exception ignored){}player.release();player=null;}if(vibrator!=null)vibrator.cancel();active="";}
}
