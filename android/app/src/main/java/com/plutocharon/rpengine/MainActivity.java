package com.plutocharon.rpengine;

import android.os.Bundle;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  /**
   * 系统栏避让（状态栏 / 摄像头孔 / 手势导航条）。
   *
   * 为什么不走 SystemBars 插件：alpha.3/4 已把配置放进正确的
   * plugins.SystemBars 节点并确认打入 APK，但实机（Android 15/16 强制
   * edge-to-edge）仍未生效。这里直接给 decorView 设置 insets listener：
   * 到 insets 分发时给整个窗口内容加 padding，避让区露出 windowBackground
   * （styles.xml 里设为应用深色 #14161B）。全版本确定生效，不依赖
   * WebView 版本与插件加载时序。
   *
   * 配套：capacitor.config.json 里 SystemBars.insetsHandling = "disable"，
   * 插件不再插手，避免双重 padding。
   */
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    ViewCompat.setOnApplyWindowInsetsListener(
        getWindow().getDecorView(),
        (v, insets) -> {
          Insets sys =
              insets.getInsets(
                  WindowInsetsCompat.Type.systemBars()
                      | WindowInsetsCompat.Type.displayCutout());
          boolean keyboardVisible =
              insets.isVisible(WindowInsetsCompat.Type.ime());
          // 键盘弹出时底部让位给 IME（不叠加手势条 padding）
          v.setPadding(sys.left, sys.top, sys.right,
              keyboardVisible ? 0 : sys.bottom);
          return insets;
        });
  }
}
