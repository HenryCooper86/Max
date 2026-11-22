package io.github.henrycooper86.max.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.Locale

/** The app's two interface languages, like the web client's 中文 / EN switch. */
enum class AppLanguage(val wire: String, val nativeName: String) {
    ZH("zh", "中文"),
    EN("en", "English");

    companion object {
        /** The language the system asks for: Chinese when the device language is Chinese, otherwise English. */
        fun fromLocale(locale: Locale): AppLanguage = if (locale.language.equals("zh", ignoreCase = true)) ZH else EN
    }
}

/** The wearer's Settings choice: follow the system (null in storage) or a fixed language. */
enum class LanguagePreference(val stored: String?) {
    SYSTEM(null), ZH("zh"), EN("en");

    companion object {
        fun fromStored(value: String?): LanguagePreference = entries.firstOrNull { it.stored == value } ?: SYSTEM
    }
}

/** The override beats the system language; with no override the system language decides. */
fun resolveLanguage(preference: LanguagePreference, system: Locale): AppLanguage = when (preference) {
    LanguagePreference.ZH -> AppLanguage.ZH
    LanguagePreference.EN -> AppLanguage.EN
    LanguagePreference.SYSTEM -> AppLanguage.fromLocale(system)
}

/**
 * Process-wide current language. It is Compose snapshot state, so any composable (or function
 * called while composing) that reads a string through [tr] recomposes when it changes: the
 * language switches live without recreating the activity. Non-UI code (status text, the service
 * notifications) reads the same value. Defaults to Chinese until the view model applies the
 * wearer's choice, which keeps unit tests on the original Chinese strings.
 */
object Localization {
    var language: AppLanguage by mutableStateOf(AppLanguage.ZH)
        internal set

    var preference: LanguagePreference by mutableStateOf(LanguagePreference.SYSTEM)
        private set

    fun apply(preference: LanguagePreference, system: Locale = Locale.getDefault()) {
        this.preference = preference
        language = resolveLanguage(preference, system)
    }

    /** For tests: pin the language directly. */
    internal fun forTest(language: AppLanguage) {
        preference = if (language == AppLanguage.ZH) LanguagePreference.ZH else LanguagePreference.EN
        this.language = language
    }
}

/** The language composables see through the composition (mirrors [Localization.language]). */
val LocalAppLanguage = compositionLocalOf { AppLanguage.ZH }

/** Looks up a string in the current language, substituting `{name}`-style parameters. */
fun tr(key: Str, vararg args: Pair<String, Any?>): String = key.text(Localization.language, *args)

/** Composable lookup that reads the language from the composition. */
@Composable
fun t(key: Str, vararg args: Pair<String, Any?>): String = key.text(LocalAppLanguage.current, *args)

/** A user-visible string in both languages. Parameters are written `{name}`. */
enum class Str(val zh: String, val en: String) {
//@@STRINGS@@
    TURN_IDLE("待机", "Standby"),
    TURN_LISTENING("免提待命 · 请讲话", "Hands-free ready · speak now"),
    TURN_HEARING("正在聆听…", "Listening…"),
    TURN_THINKING("{name} 思考中…", "{name} is thinking…"),
    TURN_SPEAKING("{name} 回答中", "{name} is responding"),
    HAZARD_CAUTION("注意路况", "Watch the road"),
    HAZARD_CRITICAL("高风险 · 优先安全", "High risk · safety first"),
    CONN_OFFLINE("离线", "Offline"),
    CONN_CONNECTING("连接中", "Connecting"),
    CONN_RELAY("中继在线", "Relay online"),
    CONN_PROVIDER("代理握手", "Provider handshake"),
    CONN_READY("已就绪", "Ready"),
    CONN_DEGRADED("降级", "Degraded"),
    MIC_MUTED("麦克风已静音", "Microphone muted"),
    TAP_VISOR("点按镜面开始对话", "Tap the visor to start"),
    NOT_CONNECTED("未连接", "Not connected"),
    SETTINGS("设置", "Settings"),
    BLUETOOTH_AUDIO("蓝牙音频", "Bluetooth audio"),
    GREETING("你好，我是 {name}", "Hi, I'm {name}"),
    HINT_WAKE("{caption}，或说“{wake}”", "{caption}, or say “{wake}”"),
    PILL_CAPTIONS("字幕", "Captions"),
    PILL_UNMUTE("取消静音", "Unmute"),
    PILL_MUTE("静音", "Mute"),
    PILL_GALLERY("相册", "Gallery"),
    RECORDING_NOTICE("正在录像（无声）· 说“停止录像”结束", "Recording (no sound) · say “stop recording” to end"),
    CAPTIONS_EMPTY("暂无字幕", "No captions yet"),
    SPEAKER_YOU("你", "You"),
    FLAG_ISSUE("有问题?", "Problem?"),
    CONFIRM_DEST("请确认目的地", "Confirm destination"),
    NAV_TO_TURN("距下一路口 {distance}", "Next turn in {distance}"),
    NAV_REMAINING("剩余 {remaining}", "{remaining} remaining"),
    OFF_ROUTE("已偏离路线", "Off route"),
    CANCEL("取消", "Cancel"),
    CONFIRM_NAV("确认导航", "Start navigation"),
    OPEN_NAV("打开详细导航", "Open detailed navigation"),
    MUSIC("音乐", "Music"),
    COLLAPSE("收起", "Collapse"),
    FULL_ROUTE("全程", "Full route"),
    FOLLOW_ME("跟随位置", "Follow me"),
    DEFAULT_INSTRUCTION("沿路线前往目的地", "Follow the route to your destination"),
    REROUTING("重新规划中", "Rerouting"),
    DIST_AHEAD("{distance} 后", "in {distance}"),
    MINUTES_LEFT("{n} 分钟", "{n} min"),
    REMAINING_SUFFIX("{distance} · 剩余", "{distance} · remaining"),
    ETA("预计到达", "ETA"),
    ROUTE("路线", "Route"),
    NO_STEPS("暂无更多路口信息，请按当前路线行驶。", "No more turns to show. Follow the current route."),
    FROM_HERE("距当前位置 {distance}", "{distance} from here"),
    DIST_KM("%.1f公里", "%.1f km"),
    DIST_M("{n}米", "{n} m"),
    DIST_WITH_MIN("{distance} · {n}分钟", "{distance} · {n} min"),
    GALLERY_TITLE("{name} 相册", "{name} gallery"),
    BACK("返回", "Back"),
    CLOSE("关闭", "Close"),
    GALLERY_EMPTY("还没有拍摄内容。对 {name} 说“拍照”或“开始录像”。", "Nothing captured yet. Say “take a photo” or “start recording” to {name}."),
    VIDEO("录像", "Video"),
    PHOTO("照片", "Photo"),
    EXPORTED("已导出", "Exported"),
    EXPORT_TO_GALLERY("导出到相册", "Export to gallery"),
    SAVE_OR_SHARE("保存或分享", "Save or share"),
    EXPORT_OK("已导出到系统相册", "Exported to the system gallery"),
    EXPORT_FAIL("导出失败，请重试", "Export failed. Try again."),
    DELETE("删除", "Delete"),
    DELETE_TITLE("删除拍摄内容？", "Delete this capture?"),
    DELETE_BODY("将删除 {name} 中的原文件，已导出到系统相册的副本会保留。", "This deletes the original in {name}. A copy exported to the system gallery is kept."),
    DELETE_FAIL("删除失败，请重试", "Delete failed. Try again."),
    VIDEO_PREVIEW("录像预览", "Video preview"),
    PREVIEW_LOADING("预览加载中", "Loading preview"),
    PREVIOUS("上一首", "Previous"),
    PAUSE("暂停", "Pause"),
    PLAY("播放", "Play"),
    NEXT("下一首", "Next"),
    QUEUE_END("已到播放队列末尾，请选择多首歌曲。", "End of the queue. Choose more songs."),
    PLAY_FAIL("暂时无法播放，请在 {name} 中重新选择音乐。", "Can't play right now. Choose music again in {name}."),
    PREPARING("正在准备…", "Preparing…"),
    CLOSE_MUSIC_PANEL("关闭音乐面板", "Close music panel"),
    STOP_CLOSE_MUSIC("停止并关闭音乐", "Stop and close music"),
    QQ_HELP("先在 QQ 音乐播放歌曲，再授权 {name} 控制其媒体会话。系统权限名为通知使用权；{name} 不读取或保存通知内容。关闭面板不会停止 QQ 音乐。", "Play a song in QQ Music first, then allow {name} to control its media session. The system permission is called notification access; {name} does not read or store notification content. Closing this panel does not stop QQ Music."),
    OPEN_QQ("打开 QQ 音乐", "Open QQ Music"),
    GRANT_CONTROL("授权控制", "Grant control"),
    USE_LOCAL_MUSIC("改用本机音乐", "Use music on this phone"),
    USE_QQ_MUSIC("改用 QQ 音乐", "Use QQ Music"),
    HUD_DISCONNECT("断开 HUD", "Disconnect HUD"),
    HUD_CAST("投屏到 HUD", "Cast to HUD"),
    HUD_HELP("手机与 RDK 连接同一 Wi-Fi，输入 RDK HUD 屏幕上的地址和连接码。", "Connect the phone and the RDK to the same Wi-Fi, then enter the address and code shown on the RDK HUD screen."),
    HUD_ADDRESS("RDK 地址，例如 192.168.1.20:8080", "RDK address, e.g. 192.168.1.20:8080"),
    HUD_CODE("六位连接码", "Six-digit code"),
    HUD_NOTE("开发版 Wi-Fi 原型：仅在可信网络使用。退出到后台会断开 HUD；连接中断后请手动重连。", "Development Wi-Fi prototype: use only on trusted networks. Leaving the app disconnects the HUD; reconnect manually if the link drops."),
    HUD_START("开始投屏", "Start casting"),
    DONE("完成", "Done"),
    HF_END("结束免提", "End hands-free"),
    HF_START("开启免提", "Start hands-free"),
    HF_BEGIN("开始免提", "Start hands-free"),
    HF_CANCEL_HINT("正在连接免提，点按取消", "Connecting hands-free. Tap to cancel"),
    MAP_OFF("地图未启用 · 语音导航仍可使用", "Map is off · voice navigation still works"),
    ENABLE_MAP("启用地图", "Enable map"),
    MAP_NO_KEY("地图暂不可用 · 缺少 Android 地图配置", "Map unavailable · Android map configuration missing"),
    MAP_BAD_ROUTE("地图暂不可用 · 路线数据不足", "Map unavailable · not enough route data"),
    AMAP_TITLE("高德地图与隐私", "Amap and privacy"),
    AMAP_BODY("启用后，路线和当前位置会提供给高德地图用于地图显示，高德还会接收加载地图所需的网络请求。{name} 使用现有位置数据，不启用高德定位服务。", "When enabled, the route and your current location are shared with Amap to draw the map, and Amap also receives the network requests needed to load it. {name} uses the location data it already has and does not turn on Amap location services."),
    AMAP_POLICY("查看高德地图隐私政策", "View Amap privacy policy"),
    AGREE_ENABLE("同意并启用", "Agree and enable"),
    NOT_NOW("暂不启用", "Not now"),
    MAP_FAILED("地图加载失败 · 语音导航仍可使用", "Map failed to load · voice navigation still works"),
    MAP_LOADING("正在加载地图…", "Loading map…"),
    MAP_PAUSED_HOT("手机温度过高，地图已暂停 · 语音导航仍可使用", "The phone is too hot, so the map is paused · voice navigation still works"),
    VIEW_FULL_ROUTE("查看完整路线", "View full route"),
    MAP_YOU("当前位置", "Current location"),
    RDK_RIDE("RDK 头盔骑行", "RDK helmet ride"),
    RIDE_SIGNED_IN("尚未连接头盔", "Helmet not connected yet"),
    RIDE_SIGNED_OUT("登录后可配对头盔", "Sign in to pair a helmet"),
    RIDE_CONNECTING("正在连接 / 等待头盔确认", "Connecting / waiting for the helmet to confirm"),
    RIDE_UNPAIRED("未配对", "Not paired"),
    RIDE_PAIRED("已配对", "Paired"),
    RIDE_OFFLINE("头盔离线", "Helmet offline"),
    RIDE_READY("头盔已就绪", "Helmet ready"),
    RIDE_SHARING("正在共享位置", "Sharing location"),
    RIDE_FAILED("连接失败", "Connection failed"),
    RIDE_PRIVACY("仅开始头盔骑行后共享精确位置；停止、退出账号或连接失败后停止。手机免提与头盔骑行分别使用。", "Precise location is shared only after you start a helmet ride, and stops when you stop, sign out or the connection fails. Phone hands-free and helmet rides are used separately."),
    RIDE_FIXES("{n} 次", "{n}×"),
    PAIR_CODE("头盔配对码", "Helmet pairing code"),
    PAIR("配对", "Pair"),
    STOP_SEARCH("停止搜索", "Stop searching"),
    SEARCH_HELMETS("搜索附近头盔", "Search for nearby helmets"),
    PAIR_NEARBY("配对附近头盔 {n}", "Pair nearby helmet {n}"),
    PAIR_HELP("手机与头盔需在同一网络。选择后，对头盔说“确认配对”。也可以输入配对码。", "The phone and helmet must be on the same network. After choosing, tell the helmet “confirm pairing”. You can also enter the pairing code."),
    STOP_RIDE("停止头盔骑行", "Stop helmet ride"),
    START_RIDE("开始头盔骑行", "Start helmet ride"),
    UNPAIR("解除配对", "Unpair"),
    CRASH_GROUP("摔车检测与求助", "Crash detection and help"),
    CRASH_FOOTER("通知会包含事故位置（如可用）。未收到服务器确认时，需手动拨打求助电话。", "The notification includes the crash location when available. If the server doesn't confirm, call for help manually."),
    CRASH_AVAILABLE("手机免提期间检测；疑似摔车后先询问，再报警。", "Detects during phone hands-free. After a suspected crash it checks on you first, then raises the alarm."),
    CRASH_NO_SENSOR("本机缺少所需运动传感器，无法自动检测摔车。", "This phone lacks the motion sensors needed to detect crashes automatically."),
    EMERGENCY_CONTACT("紧急联系人电话（含国家区号）", "Emergency contact phone (with country code)"),
    ALLOW_NOTIFY("允许中继通知该联系人", "Allow the relay to notify this contact"),
    HELP_NUMBER("求助电话", "Help number"),
    CONTACT("联系人", "Contact"),
    LOG_ONLY("仅记录检测（不报警）", "Log detections only (no alarm)"),
    CRASH_DRILL("本地摔车演练（不通知联系人）", "Local crash drill (doesn't notify the contact)"),
    UNPAIR_TITLE("解除头盔配对？", "Unpair the helmet?"),
    UNPAIR_BODY("将停止位置共享，并解除账号与头盔的绑定。", "This stops location sharing and unlinks the helmet from your account."),
    ARE_YOU_OK("你还好吗？", "Are you OK?"),
    CRASH_HELP("疑似摔车 · 求助", "Suspected crash · calling for help"),
    SECONDS("{n} 秒", "{n} s"),
    CRASH_CHECK_BODY("没事请说“我没事”，或点击下方按钮。", "If you're fine, say “I'm OK” or tap the button below."),
    CRASH_ALARM_BODY("正在报警；倒计时结束后请求中继通知。", "Raising the alarm; when the countdown ends the relay is asked to notify your contact."),
    IM_OK_CANCEL("我没事 · 取消报警", "I'm OK · cancel alarm"),
    END_HF_KEEP_ALARM("结束免提（保持报警）", "End hands-free (keep alarm)"),
    OPEN_CONTACT_DIAL("打开联系人拨号", "Open dialer for contact"),
    OPEN_120_DIAL("打开 120 拨号", "Open dialer for 120"),
    LOGIN_HELP("使用网页测试平台的账号登录；登录后自动获取会话令牌。", "Sign in with your web test platform account. The session token is fetched automatically."),
    USERNAME("用户名", "Username"),
    PASSWORD("密码", "Password"),
    SIGNING_IN("登录中…", "Signing in…"),
    SIGN_IN("登录", "Sign in"),
    ACCOUNT("账号", "Account"),
    ROLE_ADMIN("管理员", "Administrator"),
    ROLE_TESTER("测试员", "Tester"),
    SIGN_OUT("退出登录", "Sign out"),
    VOICE("语音", "Voice"),
    VOICE_SOUND("声音", "Sound"),
    VOICE_TONE("语气", "Tone"),
    MODE("模式", "Mode"),
    MUSIC_PLAYER("音乐播放器", "Music player"),
    OPEN_PLAYBACK("打开播放控制", "Open playback controls"),
    CONNECTION("连接", "Connection"),
    CURRENT_SERVER("当前服务器", "Current server"),
    SERVER_LOCKED("结束免提后可修改服务器地址。", "End hands-free to change the server address."),
    RELAY_FIELD("语音中继地址（ws:// 或 wss://）", "Voice relay address (ws:// or wss://)"),
    TOKEN_FIELD("认证令牌（网页「复制令牌」获取）", "Auth token (from “Copy token” on the web)"),
    TRUST_SELF("信任自签名证书（仅调试）", "Trust self-signed certificate (debug only)"),
    QA_GROUP("QA 任务归因", "QA task attribution"),
    QA_HELP("从网页管理台的 Release runs 复制任务标识。下一次会话会按构建、平台和任务进入发布证据矩阵。", "Copy the task identifiers from Release runs in the web admin console. The next session is recorded in the release evidence matrix by build, platform and task."),
    RUN_ID("Run ID（可选）", "Run ID (optional)"),
    ASSIGNMENT_ID("Assignment ID（可选）", "Assignment ID (optional)"),
    RIDE_INTEL("骑行情报", "Ride intel"),
    WIND("风速 {n} km/h", "Wind {n} km/h"),
    RISK_HIGH("高风险", "High risk"),
    RISK_CAUTION("注意", "Caution"),
    RISK_NORMAL("正常", "Normal"),
    WEATHER("天气", "Weather"),
    WEATHER_PENDING("激活后接入定位天气", "Weather for your location appears once active"),
    SPEED_SEGMENT("车速 · 路段", "Speed · segment"),
    BATTERY("电量", "Battery"),
    PENDING_INTENT("待识别", "Pending"),
    DEMO_SCENARIOS("演示场景", "Demo scenarios"),
    SCENARIO("场景", "Scenario"),
    GUIDED_TOUR("巡游演示", "Guided tour"),
    DIAGNOSTICS("诊断", "Diagnostics"),
    LATENCY("延迟", "Latency"),
    ASR_LINE("思考 {a} · 首音 {b} · 总计 {c}ms", "think {a} · first audio {b} · total {c} ms"),
    EXPORT_LOG("导出日志", "Export log"),
    CLEAR_LOG("清空对话记录", "Clear conversation log"),
    ASSISTANT("助手", "Assistant"),
    NAME("名称", "Name"),
    DEVICE("设备", "Device"),
    NEEDS_KEY("需配置 API 密钥", "Needs an API key"),
    CURRENT_BACKEND("当前语音后端", "Current voice backend"),
    VOICE_BACKEND("语音后端", "Voice backend"),
    KIND_DEMO("演示", "Demo"),
    KIND_LIVE("实时", "Live"),
    KIND_PIPELINE("流水线", "Pipeline"),
    LOGO_DESC("{name} 标志", "{name} logo"),
    APPEARANCE("外观", "Appearance"),
    PINNED_FOOTER("外观由所有者固定，无法在此更改。", "The look is pinned by the owner and can't be changed here."),
    TEMPLATE("模板", "Template"),
    PINNED("由所有者固定", "Pinned by the owner"),
    VOICE_DISPLAY("语音显示", "Voice display"),
    SELECTED_SUFFIX("，已选中", ", selected"),
    ERR_LOGIN_FIRST("请先登录账号", "Sign in first"),
    ERR_END_HF_FIRST("请先结束手机免提，再连接头盔", "End phone hands-free before connecting the helmet"),
    ERR_BAD_PAIR_CODE("配对码无效", "Invalid pairing code"),
    ERR_LOGIN_AND_END_HF("请登录账号并结束手机免提", "Sign in and end phone hands-free"),
    ERR_PRECISE_LOCATION("骑行定位需要精确位置权限", "Ride tracking needs the precise location permission"),
    ERR_RIDE_START("无法启动骑行，请在应用内重试", "Couldn't start the ride. Try again in the app."),
    ERR_ENTER_CREDENTIALS("请输入用户名和密码", "Enter your username and password"),
    ERR_LOGIN_FAILED("登录失败，请重试", "Sign-in failed. Try again."),
    EXPORT_CHOOSER("导出对话记录", "Export conversation log"),
    ERR_RELAY_BAD("中继地址无效，请检查设置", "Invalid relay address. Check Settings."),
    ERR_RELAY_UNREACHABLE("无法连接服务器，请检查中继地址", "Can't reach the server. Check the relay address."),
    STATUS_MIC_INTERRUPTED("麦克风已中断，请重新开启免提", "Microphone interrupted. Turn hands-free back on."),
    STATUS_AUDIO_UNAVAILABLE("音频播放不可用，请检查音频设备", "Audio playback unavailable. Check your audio device."),
    STATUS_RELAY_BAD("中继地址无效，请在设置中检查服务器地址", "Invalid relay address. Check the server address in Settings."),
    STATUS_MIC_UNAVAILABLE("麦克风不可用，请检查录音权限", "Microphone unavailable. Check the recording permission."),
    STATUS_MALE("已切换到男声", "Switched to the male voice"),
    STATUS_FEMALE("已切换到女声", "Switched to the female voice"),
    STATUS_TONE("已切换语气：{label}", "Tone changed: {label}"),
    STATUS_TOUR_ON("巡游演示已开启，开启免提后自动巡游场景", "Guided tour is on. Scenarios play automatically once hands-free starts."),
    STATUS_RECONNECTING("重新连接中…（第 {n} 次）", "Reconnecting… (attempt {n})"),
    STATUS_READY("就绪", "Ready"),
    STATUS_BAD_PROVIDER("收到异常代理消息", "Received an invalid provider message"),
    STATUS_IDLE_ENDED("会话闲置已断开，请重新开启免提", "Session ended after being idle. Turn hands-free back on."),
    STATUS_LOGIN_REQUIRED("需要登录：在设置的「账号」里登录（或粘贴认证令牌）", "Sign-in required: sign in under Account in Settings (or paste an auth token)"),
    STATUS_RELAY_REFUSED("中继拒绝连接（HTTP {status}），请检查中继地址", "The relay refused the connection (HTTP {status}). Check the relay address."),
    STATUS_RELAY_FAILED("语音中继连接失败，请重新开启免提", "Couldn't reach the voice relay. Turn hands-free back on."),
    STATUS_RECONNECT_IN("连接已断开，{n} 秒后自动重连…", "Disconnected. Reconnecting in {n} s…"),
    STATUS_MOCK_ON("模拟路线已启用", "Simulated route enabled"),
    STATUS_DOUBAO_ON("豆包实时语音在线", "Doubao realtime voice online"),
    STATUS_SAFETY_SOUND_FAILED("安全提示音播放失败，请留意警示信息", "Safety alert sound failed. Watch the warnings."),
    STATUS_INTERRUPTED("已打断 {name}，继续听你说", "Interrupted {name}. Listening to you."),
    AUDIO_PAUSED("其他应用正在使用音频 · 已暂停", "Another app is using audio · paused"),
    STATUS_AUDIO_PAUSED("其他应用正在使用音频，{name} 已暂停收听，结束后自动继续", "Another app is using audio. {name} has paused and will resume when it ends."),
    STATUS_AUDIO_RESUMED("{name} 已恢复收听", "{name} is listening again"),
    STATUS_VOICE_DOWN("麦克风不可用，{name} 暂时听不到你；摔车检测仍在运行，正在自动重试", "The microphone stopped working, so {name} can't hear you for now. Crash detection is still on, and the microphone is being retried."),
    VOICE_DOWN("麦克风不可用 · 摔车检测仍开启", "Microphone unavailable · crash detection still on"),
    STATUS_AUDIO_YIELDED("其他应用正在播放，{name} 仍在收听，说话时会暂时压低它", "Another app is playing audio. {name} is still listening and will lower it to speak."),
    STATUS_WAITING_NETWORK("网络已断开，恢复后自动重连", "No network. Reconnecting as soon as it's back."),
    TOOL_RUNNING("正在使用工具：{tool}…", "Using {tool}…"),
    TOOL_FAILED("工具未完成：{tool}", "Couldn't finish {tool}"),
    TYPE_HINT("输入消息", "Type a message"),
    TYPE_SEND("发送", "Send"),
    PICTURE_SHOW("给助手看一张图片", "Show the assistant a picture"),
    PICTURE_SENDING("正在发送图片…", "Sending the picture…"),
    PICTURE_SENT("图片已发给助手，接着说或输入你的问题。", "The assistant has the picture. Say or type what you want to know."),
    PICTURE_NOT_READY("现在发不了图片，请稍后再试。", "A picture can't be sent right now. Try again in a moment."),
    PICTURE_TOO_FAST("每秒最多发一张图片。", "One picture a second at most."),
    PICTURE_TOO_MANY("这次对话的图片已达上限。", "This conversation has had as many pictures as it can take."),
    PICTURE_UNREADABLE("这张图片打不开，或者太大，发不了。", "That picture could not be opened, or is too large to send."),
    SMS_SPEED_UNKNOWN("现在无法确认你是否在骑行，暂时不发短信。等 GPS 定位后再试。", "I can't tell whether you're riding right now, so I won't write a text yet. Try again once GPS has a fix."),
    TYPE_STOP_FIRST("停车后才能输入", "Stop to type"),
    LOAD_HOT("手机过热，已停止录像，降温后可再次录像。", "The phone is hot, so video recording is off until it cools down."),
    LOAD_CRITICAL("手机温度过高，已关闭相机、音乐和投屏；语音和摔车检测仍在运行。", "The phone is very hot. Camera, music and casting are off; voice and crash detection keep running."),
    LOAD_POWER_SAVE("省电模式已开启，录像已关闭。", "Battery saver is on, so video recording is off."),
    LOAD_RESTORED("手机已恢复正常，可以再次录像。", "The phone is back to normal. Video recording is available again."),
    LOAD_REFUSED_HOT("手机太热了，等降温后再试。", "The phone is too hot for that right now. Try again once it cools down."),
    LOAD_REFUSED_POWER_SAVE("省电模式下不能录像，关闭省电模式后再试。", "Video recording is off while battery saver is on."),
    HUD_NOT_CASTING("未投屏", "Not casting"),
    HUD_NEEDS_DEBUG("Wi-Fi 投屏原型需要开发版本", "The Wi-Fi casting prototype needs a development build"),
    HUD_NEEDS_INPUT("请输入 RDK 屏幕上的地址和六位连接码", "Enter the address and six-digit code shown on the RDK screen"),
    HUD_WAIT_NAV("等待手机导航更新后重试", "Wait for the phone's navigation to update, then try again"),
    HUD_CONNECTING("正在连接 HUD…", "Connecting to the HUD…"),
    HUD_CONNECTED_SENDING("已连接 · 正在发送导航", "Connected · sending navigation"),
    HUD_CASTING("正在投屏到 HUD", "Casting to the HUD"),
    HUD_BAD_RESPONSE("HUD 响应无效", "Invalid HUD response"),
    HUD_DROPPED_CHECK("HUD 已断开，请检查 Wi-Fi 和连接码后重试", "HUD disconnected. Check the Wi-Fi and code, then try again."),
    HUD_PAIR_EXPIRED("配对已失效或 HUD 正忙，请重新配对", "Pairing expired or the HUD is busy. Pair again."),
    HUD_DROPPED_WAITING("HUD 已断开，正在等待重新连接", "HUD disconnected. Waiting to reconnect."),
    HUD_TIMEOUT("HUD 连接超时，请重新连接", "HUD connection timed out. Reconnect."),
    HUD_DROPPED_RECONNECT("HUD 已断开，请重新连接", "HUD disconnected. Reconnect."),
    HUD_RECONNECTING("连接中断 · 自动重连中（点断开可取消）", "Connection lost · reconnecting (tap Disconnect to cancel)"),
    HUD_NO_NAV_DATA("当前导航数据暂时无法投屏", "The current navigation data can't be cast right now"),
    CRASH_SIGNED_OUT("账号已退出，请手动拨打求助电话", "Signed out. Call for help manually."),
    CRASH_UNCONFIRMED("服务器未确认，请手动拨打求助电话", "The server didn't confirm. Call for help manually."),
    CRASH_NOTIFIED("已通知紧急联系人。", "Your emergency contact was notified."),
    CRASH_NO_CHANNEL("服务器未配置通知通道，请手动拨打求助电话。", "The server has no notification channel configured. Call for help manually."),
    CRASH_NOTIFY_FAILED("紧急联系人通知失败，请手动拨打求助电话。", "Couldn't notify your emergency contact. Call for help manually."),
    CRASH_DRILL_NOTE("演练：不会通知联系人", "Drill: your contact will not be notified"),
    CRASH_DRILL_OVER("演练结束：未发送通知", "Drill over: no notification sent"),
    CRASH_CALL_MANUALLY("请手动拨打求助电话", "Call for help manually"),
    COMP_SIGN_IN("请先登录账号并检查服务器地址", "Sign in and check the server address first"),
    COMP_TIMEOUT("头盔确认超时，请重试", "Helmet confirmation timed out. Try again."),
    COMP_PAIR_FAILED("配对失败", "Pairing failed"),
    COMP_SESSION_EXPIRED("登录失效，请重新登录", "Sign-in expired. Sign in again."),
    COMP_LINK_LOST("头盔连接中断，请重试", "Helmet connection lost. Try again."),
    COMP_RECONNECTING("连接中断，正在重连", "Connection lost. Reconnecting"),
    NOTIF_RIDE_CHANNEL("头盔骑行定位", "Helmet ride tracking"),
    NOTIF_RIDE_TITLE("{name} 头盔骑行", "{name} helmet ride"),
    NOTIF_RIDE_TEXT("正在向已配对头盔共享位置", "Sharing location with the paired helmet"),
    NOTIF_RIDE_STOP("停止共享", "Stop sharing"),
    ERR_LOCATION_OFF("请开启系统定位后重试", "Turn on system location and try again"),
    ERR_RIDE_TRACKING("无法启动骑行定位，请检查权限并在应用内重试", "Couldn't start ride tracking. Check permissions and try again in the app."),
    ERR_PRECISE_REVOKED("精确位置权限已撤销", "Precise location permission was revoked"),
    ERR_LOCATION_DISABLED("系统定位已关闭，请开启后重试", "System location is off. Turn it on and try again."),
    NOTIF_CRASH_CHANNEL("摔车检查与求助", "Crash check and help"),
    NOTIF_CRASH_TITLE("疑似摔车 · 你还好吗？", "Suspected crash · are you OK?"),
    NOTIF_CRASH_TEXT("{n} 秒 · 点击查看或取消报警", "{n} s · tap to view or cancel the alarm"),
    NOTIF_CRASH_CANCEL("我没事 · 取消", "I'm OK · cancel"),
    MUSIC_RETURN("请回到 {name} 中播放音乐。", "Return to {name} to play music."),
    MUSIC_NO_QUEUE("暂无播放队列，请在 {name} 中选择音乐。", "No playback queue. Choose music in {name}."),
    MUSIC_PREPARING_TITLE("正在准备音乐", "Preparing music"),
    MUSIC_LOAD_TIMEOUT("音乐加载超时，请重新选择。", "Music took too long to load. Choose again."),
    MUSIC_PLAY_FAILED("音乐无法播放，请重新选择音频文件。", "Couldn't play the music. Choose an audio file again."),
    QQ_NOT_INSTALLED("无法打开 QQ 音乐，请先安装 QQ 音乐。", "Couldn't open QQ Music. Install QQ Music first."),
    QQ_ACCESS("请在系统设置中打开 {name} 的通知使用权。", "Turn on notification access for {name} in system settings."),
    QQ_NEEDS_PERMISSION("请点“授权控制”，在系统通知使用权设置中允许 {name}。授权用于读取 QQ 音乐的媒体会话；{name} 不读取或保存通知内容。", "Tap “Grant control” and allow {name} in the system notification access settings. This lets it read QQ Music's media session; {name} does not read or store notification content."),
    QQ_OPEN_FIRST("请打开 QQ 音乐，先选择并播放一首歌，再返回 {name}。", "Open QQ Music, choose and play a song, then return to {name}."),
    QQ_NO_ACTION("QQ 音乐当前未提供此操作，请在 QQ 音乐中操作。", "QQ Music doesn't offer this action right now. Use QQ Music directly."),
    QQ_UNKNOWN_SONG("无法确认 QQ 音乐的当前歌曲，请在 QQ 音乐中切歌。", "Can't confirm QQ Music's current song. Change songs in QQ Music."),
    QQ_PERMISSION_OFF("音乐控制权限已关闭，请重新授权。", "Music control permission was turned off. Grant it again."),
    QQ_UNCONFIRMED("QQ 音乐未确认此操作。请检查播放队列或在 QQ 音乐中操作。", "QQ Music didn't confirm this action. Check the queue or use QQ Music directly."),
    QQ_GRANT_FIRST("请先授权音乐控制。", "Grant music control first."),
    QQ_SESSION_LOST("QQ 音乐播放会话已断开，请打开 QQ 音乐后重试。", "The QQ Music session ended. Open QQ Music and try again."),
    // Manually keyed strings (enum labels, templates, voice styles, directions).
    LANGUAGE_ROW("语言 / Language", "语言 / Language"),
    LANGUAGE_NOTE("助手会用这里选择的语言回答（若它会说该语言）。", "The assistant answers in this language when it speaks it."),
    LANG_FOLLOW("跟随系统", "Follow system"),
    LANG_ZH("中文", "中文"),
    LANG_EN("English", "English"),
    GENDER_FEMALE("女声", "Female"),
    GENDER_MALE("男声", "Male"),
    TONE_CONCISE("极简", "Concise"),
    TONE_FRIENDLY("友好", "Friendly"),
    TONE_TECHNICAL("技术", "Technical"),
    TONE_RALLY("领航", "Rally"),
    HZ_NORMAL("稳定", "Steady"),
    HZ_NORMAL_ACTION("保持节奏，专注下一步提示", "Keep your pace and focus on the next prompt"),
    HZ_CAUTION_ACTION("放缓一点，扩大车距", "Slow down a little and leave more space"),
    HZ_CRITICAL_ACTION("优先靠边，确认安全", "Pull over first and confirm it's safe"),
    MODE_RIDE("骑行", "Ride"),
    MODE_NAV("导航", "Navigation"),
    MODE_STOP("停车", "Parked"),
    MODE_EMERGENCY("紧急", "Emergency"),
    SC_COMMUTE("通勤", "Commute"),
    SC_WIND("横风", "Crosswind"),
    SC_FUEL("低油", "Low fuel"),
    SC_GROUP("小队", "Group"),
    NET_ONLINE("在线", "Online"),
    NET_WEAK("弱网", "Weak network"),
    FLAG_MISHEARD("听错了", "Misheard"),
    FLAG_WRONG("回答不对", "Wrong answer"),
    FLAG_SLOW("太慢", "Too slow"),
    FLAG_UNSAFE("不安全", "Unsafe"),
    DIR_FRONT("前方", "Ahead"),
    DIR_REAR("后方", "Behind"),
    DIR_LEFT("左侧", "Left"),
    DIR_RIGHT("右侧", "Right"),
    DIR_LEFT_REAR("左后方", "Left rear"),
    DIR_RIGHT_REAR("右后方", "Right rear"),
    WAITING_RIDE_CONTEXT("等待骑行上下文", "Waiting for ride context"),
    NEXT_PROMPT("下一步提示", "Next prompt"),
    WEATHER_LOW_RISK("天气风险较低，保持正常安全骑行。", "Weather risk is low. Keep riding safely."),
    WAITING_ROUTE("等待路线信息", "Waiting for route info"),
    DEVICE_HELMET("头盔", "Helmet"),
    DEVICE_GLASSES("眼镜", "Glasses"),
    DEVICE_OTHER("设备", "Device"),
    SEP("，", ", "),
    NAV_STOP("已停止导航。", "Navigation stopped."),
    NAV_ARRIVED("已到达目的地。", "You have arrived."),
    NAV_OFF_ROUTE("已偏离路线，正在重新规划。", "You're off the route. Recalculating."),
    NAV_REROUTE_FAILED("无法重新规划路线，已停止导航。", "I couldn't find a new route. Navigation has stopped."),
    NAV_LOCATING("正在定位…", "Locating…"),
    NAV_CONFIRM_PROMPT("请确认目的地：{name}。确认后开始导航。", "Confirm the destination: {name}. Say “confirm navigation” or tap Confirm to start turn-by-turn guidance."),
    NOTIF_CHANNEL("免提语音会话", "Hands-free voice session"),
    NOTIF_TITLE("{name} 免提语音运行中", "{name} hands-free voice is running"),
    NOTIF_TEXT("正在监听你的语音", "Listening to your voice"),
    TPL_VISOR("护目镜", "Visor"),
    TPL_VISOR_D("默认深色界面，一种信号色", "The default dark look with one signal colour"),
    TPL_DAYLIGHT("日光", "Daylight"),
    TPL_DAYLIGHT_D("浅色高亮，适合户外阳光和太阳镜", "Light and crisp for sunlight, sunglasses and cycling"),
    TPL_BEACON("灯塔", "Beacon"),
    TPL_BEACON_D("高对比、大字号，适合低视力辅助眼镜", "High contrast and large type for low-vision glasses"),
    TPL_EMBER("余烬", "Ember"),
    TPL_EMBER_D("暖色深色，夜骑时减少蓝光", "Warm dark with an amber accent, low on blue light"),
    TPL_HOLO("全息", "Holo"),
    TPL_HOLO_D("冷色深空，适合 AR 与 VR 头显", "Cool deep-space dark for AR and VR headsets"),
    VS_WAVE("波形", "Wave"),
    VS_WAVE_D("一条随声音起伏的线", "A line that rises and falls with the voice"),
    VS_BARS("频谱", "Bars"),
    VS_BARS_D("频谱柱，峰值缓缓回落", "Spectrum bars with slowly falling peaks"),
    VS_MIRROR("镜像", "Mirror"),
    VS_MIRROR_D("以中线上下对称的频谱", "Bars mirrored above and below the centre line"),
    VS_DOTS("点阵", "Dots"),
    VS_DOTS_D("点阵式电平，亮起峰值点", "A dot-matrix level meter with a lit peak"),
    VS_RING("环形", "Ring"),
    VS_RING_D("围绕圆心的放射线", "Spokes radiating around a core"),
    ;

    fun text(language: AppLanguage, vararg args: Pair<String, Any?>): String {
        var out = if (language == AppLanguage.EN) en else zh
        for ((name, value) in args) out = out.replace("{$name}", value?.toString().orEmpty())
        return out
    }
}

/** Template name and one-line description in the current language. */
val io.github.henrycooper86.max.ui.theme.VisorTemplate.name: String
    get() = when (id) {
        "daylight" -> tr(Str.TPL_DAYLIGHT)
        "beacon" -> tr(Str.TPL_BEACON)
        "ember" -> tr(Str.TPL_EMBER)
        "holo" -> tr(Str.TPL_HOLO)
        else -> tr(Str.TPL_VISOR)
    }

val io.github.henrycooper86.max.ui.theme.VisorTemplate.blurb: String
    get() = when (id) {
        "daylight" -> tr(Str.TPL_DAYLIGHT_D)
        "beacon" -> tr(Str.TPL_BEACON_D)
        "ember" -> tr(Str.TPL_EMBER_D)
        "holo" -> tr(Str.TPL_HOLO_D)
        else -> tr(Str.TPL_VISOR_D)
    }

/** The stored music labels ("QQ音乐", "Max 音乐", "音乐") shown in the current language. */
fun musicLabel(stored: String): String = when (stored) {
    "QQ音乐" -> "QQ Music".takeIf { Localization.language == AppLanguage.EN } ?: stored
    "Max 音乐" -> "Max Music".takeIf { Localization.language == AppLanguage.EN } ?: stored
    "音乐" -> tr(Str.MUSIC)
    "正在准备音乐" -> tr(Str.MUSIC_PREPARING_TITLE)
    else -> stored
}

private val zhIndex: Map<String, Str> by lazy {
    Str.entries.filter { '{' !in it.zh && it.zh != it.en }.groupBy { it.zh }.mapValues { it.value.first() }
}

/**
 * Status strings are stored as plain text when they are produced, so one written before a
 * language switch (or before the language was applied at launch) is still Chinese. A stored
 * string that is exactly one of the table's Chinese texts is shown in the current language;
 * anything else (relay text, names, parameterised messages) is returned as received.
 */
fun relocalize(text: String): String = zhIndex[text]?.let { tr(it) } ?: text

/** English names of the eight device profiles (the relay's label is in its own primary language). */
fun deviceDisplayName(profile: String?, relayLabel: String?, kind: DeviceKind): String {
    if (Localization.language == AppLanguage.EN) {
        when (profile?.trim()?.lowercase()) {
            "motorcycle-helmet" -> return "Motorcycle helmet"
            "bicycle-helmet" -> return "Bicycle helmet"
            "sunglasses" -> return "Sunglasses"
            "smart-glasses" -> return "Smart glasses"
            "assistive-glasses" -> return "Assistive glasses"
            "ar-headset" -> return "AR headset"
            "vr-headset" -> return "VR headset"
            "wearable" -> return "Wearable"
        }
        return kind.noun
    }
    return relayLabel ?: kind.noun
}
