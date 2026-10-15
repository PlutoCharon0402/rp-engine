# Android Alpha 版本发布说明

## 当前版本：0.5.0-alpha.1（versionCode 1）

## 构建方法

```bash
npm run apk
```

一条命令完成：`vite build` → `cap sync android` → `gradlew assembleRelease`。
产物：`android/app/build/outputs/apk/release/app-release.apk`（约 3.2MB，universal，含所有 ABI）。

### 签名

- Keystore：`android/rpengine-alpha.keystore`（**已 gitignore，绝不提交**）
- 配置：`android/keystore.properties`（密码在内，同样不进 git）
- 签名丢失 = 无法覆盖安装（只能卸载重装，会丢数据）→ **备份 keystore 文件**

### 版本号规则

| 项 | 位置 | 规则 |
|---|---|---|
| `versionName` | `android/app/build.gradle` | 跟随 package.json + alpha 后缀，如 `0.5.0-alpha.1` |
| `versionCode` | `android/app/build.gradle` | 从 1 起每次构建 **+1**，忘了递增会被 Android 拒绝覆盖安装 |

## 安装到手机

1. 把 `RP-Engine-0.5.0-alpha.1.apk` 传到手机（微信文件传输 / USB / 网盘均可）
2. 点开 APK → 系统提示"不允许安装未知应用" → 去设置允许当前来源安装
3. 装完桌面出现「RP Engine」图标

### ⚠️ 更新与数据

- **覆盖安装**（同包名同签名）→ IndexedDB 数据与 localStorage 的 API Key **全部保留**
- **卸载重装** → 数据清零。更新一律覆盖安装，别卸载
- 重大操作前用「设置 → 导出备份」做兜底

## 本版已知限制

- 需自备模型 API Key（设置页填，如 DeepSeek platform.deepseek.com）
- 不支持浏览器 CORS 的厂商（如通义 DashScope）在 APK 里同样不可用
- 多角色群聊、世界书语义检索未实现（见 README 路线图）
- Android 返回键：会话内返回列表、列表内直接退出（暂无二次确认）

## 环境依赖（本机已就绪）

- JDK 21（Temurin）
- Android SDK：platform-tools + platforms;android-34 + build-tools;34.0.0（`~/Library/Android/sdk`，命令行安装，无需 Android Studio）
- Gradle 8.14（gradlew 自动下载）

## 故障排查

| 症状 | 处置 |
|---|---|
| `SDK location not found` | 检查 `android/local.properties` 的 `sdk.dir` |
| 签名构建失败 | `android/keystore.properties` 缺失 → 参考本文档签名节重新生成（老 APK 将无法覆盖） |
| 手机上白屏 | 长按图标 → 应用信息 → 清除数据后重试；或接 USB 用 `adb logcat | grep -i capacitor` 看日志 |
| 下载 Gradle/Maven 超时 | 网络问题，重跑 `npm run apk`；必要时设 Gradle 代理 |
