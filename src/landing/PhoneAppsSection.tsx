import { useLanguage } from "../components/LanguageToggle";
import { localized } from "../lib/i18n";
import { REPOSITORY_URL } from "../lib/routes";
import { ScreenRecording } from "./ScreenRecording";

/** The native iOS and Android apps, shown as recordings of the scripted demo ride. */
export function PhoneAppsSection() {
  const { language } = useLanguage();
  const say = (zh: string, en: string) => localized(language, zh, en);
  const phones = [
    {
      id: "ios",
      title: "iPhone",
      src: "/video/phone-ios.mp4",
      poster: "/video/phone-ios.jpg",
      label: say(
        "Max iOS 应用在 iOS 模拟器中运行巡游演示的录屏，语音后端为脚本演示",
        "Screen recording of the Max iOS app running the guided demo ride in Chinese in the iOS Simulator, with the scripted demo backend"
      ),
      caption: say("在 iOS 模拟器中录制。", "Recorded in the iOS Simulator."),
      source: `${REPOSITORY_URL}/tree/main/ios`,
      sourceLabel: say("iOS 源码与构建说明", "iOS source and build steps")
    },
    {
      id: "android",
      title: "Android",
      src: "/video/phone-android.mp4",
      poster: "/video/phone-android.jpg",
      label: say(
        "Max Android 应用在 Android 模拟器中运行巡游演示的录屏，语音后端为脚本演示",
        "Screen recording of the Max Android app running the guided demo ride in Chinese in the Android Emulator, with the scripted demo backend"
      ),
      caption: say("在 Android 模拟器中录制。", "Recorded in the Android Emulator."),
      source: `${REPOSITORY_URL}/tree/main/android`,
      sourceLabel: say("Android 源码与构建说明", "Android source and build steps")
    }
  ];
  const features = [
    {
      title: say("免提对话", "Hands-free voice"),
      text: say(
        "随时打断助手，断线后自动重连。可以用手机扬声器，也可以用蓝牙耳机。",
        "Interrupt it mid-sentence, and it reconnects after a dropout. Use the phone speaker or a Bluetooth headset."
      )
    },
    {
      title: say("导航与路况", "Navigation and ride context"),
      text: say(
        "逐向导航、到达时间和改道，以及天气和前方危险提醒。",
        "Turn-by-turn guidance, arrival time and rerouting, plus weather and hazard alerts."
      )
    },
    {
      title: say("手机上的操作", "Actions on the phone"),
      text: say(
        "控制音乐、手电筒和音量，拍照或录制无声视频并让助手描述画面。打电话和发短信前由你在系统界面确认。",
        "Control music, the torch and volume. Take a photo or silent video and ask what is in it. Calls and messages open the system screen for you to confirm."
      )
    },
    {
      title: say("摔车检测", "Crash detection"),
      text: say(
        "检测到疑似摔车后先问你是否还好，没有回应才拉响警报。只有在你开启后才会通知紧急联系人。",
        "After a suspected crash it asks if you are OK, then sounds an alarm if you do not answer. It alerts an emergency contact only if you turned that on."
      )
    }
  ];
  return (
    <section className="siteSection" aria-labelledby="apps">
      <header className="sectionHead" data-reveal="">
        <h2 id="apps">{say("手机上的原生应用", "Native apps for iPhone and Android")}</h2>
        <p>
          {say(
            "iOS 和 Android 应用与网页版连接同一个中继，使用同样的语音后端和助手配置。下面是两个应用在模拟器中运行巡游演示的录屏：骑手的话由脚本提供，不需要麦克风或模型密钥。",
            "The iOS and Android apps connect to the same relay as the web app and use the same voice backends and assistant settings. Below, each app runs the guided demo ride in a simulator. The rider’s lines are scripted, so it needs no microphone or model key. The script is in Chinese, Max’s default language."
          )}
        </p>
      </header>
      <div className="phoneApps revealStagger" data-reveal="">
        {phones.map((phone) => (
          <figure key={phone.id} className="phoneApp">
            <div className="phoneFrame">
              <ScreenRecording src={phone.src} poster={phone.poster} label={phone.label} />
            </div>
            <figcaption>
              <strong>{phone.title}</strong>
              <span>{phone.caption}</span>
              <a className="siteTextLink" href={phone.source} rel="noreferrer noopener">
                {phone.sourceLabel}
              </a>
            </figcaption>
          </figure>
        ))}
      </div>
      <ul className="phoneFeatures revealStagger" data-reveal="">
        {features.map((feature) => (
          <li key={feature.title}>
            <h3>{feature.title}</h3>
            <p>{feature.text}</p>
          </li>
        ))}
      </ul>
      <p className="phoneAvailability" data-reveal="">
        {say(
          "两个应用尚未上架 App Store 或 Google Play。请用 Xcode 或 Android Studio 从源码构建，并连接到你自己的中继。",
          "The apps are not in the App Store or Google Play yet. Build them from source with Xcode or Android Studio and point them at your relay."
        )}
      </p>
    </section>
  );
}
