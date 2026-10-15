package com.qavli.youtubecommandcenterpro;
import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import androidx.browser.customtabs.CustomTabsIntent;
public class MainActivity extends Activity {
 @Override public void onCreate(Bundle state) {
  super.onCreate(state);
  CustomTabsIntent tabs = new CustomTabsIntent.Builder().setShowTitle(true).build();
  tabs.launchUrl(this, Uri.parse("https://youtube-command-center-pro-production.up.railway.app/"));
  finish();
 }
}
