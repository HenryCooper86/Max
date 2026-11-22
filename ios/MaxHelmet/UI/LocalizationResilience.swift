import Foundation

// Interruption and network recovery, device heat, typed input and tool
// activity, the unconfigured relay, and the accessibility text for the HUD's
// primary controls. (key, 中文, English)
extension LocalizationTable {
    static let resilienceRows: [(String, String, String)] = [
        // audio interruptions and network recovery
        ("main.audioPaused", "已为来电或 Siri 暂停", "Paused for a call or Siri"),
        ("main.audioFailed", "麦克风未恢复", "Microphone didn't come back"),
        ("main.networkWaiting", "等待网络…", "Waiting for network…"),
        ("st.audioInterrupted", "音频被来电或 Siri 打断，结束后自动恢复", "Audio paused for a call or Siri. Max resumes when it ends"),
        ("st.audioResumed", "音频已恢复，继续听你说", "Audio is back. Listening"),
        ("st.audioResumeFailed", "麦克风未能恢复，请结束免提后重新开启", "Couldn't get the microphone back. End hands-free and start it again"),
        ("st.networkWaiting", "网络已断开，恢复后自动重连", "No network. Max reconnects as soon as it's back"),
        // device heat and Low Power Mode
        ("thermal.hot", "手机过热，已暂停录像和画面识别；语音和摔车检测照常工作。", "The phone is running hot, so I've paused video and image analysis. Voice and crash detection keep working."),
        ("thermal.critical", "手机温度过高，已关闭相机等非必要功能；语音和摔车检测保持运行。", "The phone is too hot, so I've turned off the camera and other extras. Voice and crash detection stay on."),
        ("thermal.cooled", "手机已降温，可以重新录像了", "The phone has cooled down. Video is available again"),
        ("thermal.lowPower", "低电量模式已开启，录像暂不可用", "Low Power Mode is on, so video recording is off"),
        // typed input and tool activity
        ("typed.placeholder", "打字给 {name}", "Type to {name}"),
        ("typed.locked", "行驶中不能打字，停车后再试", "Typing is off while moving. Stop to type"),
        ("tool.activity.busy", "正在查询…", "Looking that up…"),
        // pictures for the assistant
        ("picture.show", "给 {name} 看一张图片", "Show {name} a picture"),
        ("picture.sending", "正在发送图片…", "Sending the picture…"),
        ("picture.sent", "{name} 已收到图片，接着说或输入你的问题。", "{name} has the picture. Say or type what you want to know."),
        ("picture.notReady", "现在发不了图片，请稍后再试。", "A picture can't be sent right now. Try again in a moment."),
        ("picture.moving", "行驶中不能发图片，停车后再试。", "Pictures are off while moving. Stop first."),
        ("picture.tooFast", "每秒最多发一张图片。", "One picture a second at most."),
        ("picture.tooMany", "这次对话的图片已达上限。", "This conversation has had as many pictures as it can take."),
        ("picture.unreadable", "这张图片打不开，或者太大，发不了。", "That picture could not be opened, or is too large to send."),
        // unconfigured relay
        ("relay.unset.title", "未配置语音中继", "Relay not configured"),
        ("relay.unset.body", "这个版本没有中继地址。请在「设置 › 连接」里填写你的中继地址，或在 ios/Config/Secrets.xcconfig 中设置 MAX_RELAY_HOST 后重新构建。", "This build has no relay address. Enter your relay's address under Settings › Connection, or set MAX_RELAY_HOST in ios/Config/Secrets.xcconfig and rebuild."),
        ("relay.unset.action", "打开设置", "Open Settings"),
        // accessibility
        ("a11y.mute.value.on", "麦克风已开启", "Microphone on"),
        ("a11y.mute.value.off", "麦克风已静音", "Microphone muted"),
        ("a11y.mute.hint.mute", "停止发送你的声音，{name} 仍可说话", "Stops sending your voice; {name} can still talk"),
        ("a11y.mute.hint.unmute", "恢复发送你的声音", "Starts sending your voice again"),
        ("a11y.crash.cancel", "我没事，取消警报", "I'm OK, cancel the alarm"),
        ("a11y.crash.cancel.hint", "停止警报，不通知紧急联系人", "Stops the alarm without notifying your emergency contact"),
        ("a11y.crash.call.hint", "拨打 {number}，iOS 会先请你确认", "Calls {number}; iOS asks you to confirm first"),
        ("a11y.crash.checkIn.hint", "轻点两下取消；无人响应将拉响警报", "Double-tap to cancel. If nobody answers, the alarm sounds"),
        ("a11y.typed.field", "输入消息", "Type a message"),
        ("a11y.typed.send", "发送", "Send"),
    ]
}
