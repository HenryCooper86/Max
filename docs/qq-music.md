# QQ Music integration

QQ Music is the default music source on Android, iOS, and web. Music cards remain hidden until requested. Selecting local music explicitly changes the source for that app session; a named QQ Music command switches back. No QQ account credentials or private playback endpoints are used.

| Platform | Available now                                                                                       | Limit                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android  | Control QQ Music's active media session: play, pause, next, previous; display its reported track    | Requires installed QQ Music, an existing playback queue, and notification-listener access. The installed QQ Music version must expose the requested media-session action. |
| iOS      | Open the official QQ Music website from the music card; explicit Apple Music/local-library fallback | No QQ playback SDK/API access is configured. Max cannot control playback in another iOS app.                                                                              |
| Web      | Open the official QQ Music website in another tab; explicit local-file playback fallback            | Max cannot control the other tab or access QQ Music's licensed streams.                                                                                                   |

Opening a website is a handoff, not a successful playback command. iOS and web return `music.qq.integrationRequired` for QQ playback commands, so voice responses do not claim success. Website links do not guarantee that the QQ Music native app will open.

## Android setup

1. Install QQ Music and select/play a song there.
2. Request music in Max and tap **授权控制**. Enable **Max 音乐控制** in Android's notification-access settings, then return to Max.
3. Try **下一首**, **暂停QQ音乐**, or **play QQ Music**. The card also has playback controls.

Android names this broad system permission “notification access.” Max uses it to obtain media sessions; its notification-listener service does not inspect or store notification content. Sessions are filtered to `com.tencent.qqmusic`; Max never falls back to another app's session. Access can be revoked in the same system settings.

A command is acknowledged only after the session reports the requested playback state or a changed track. A no-op, missing action, missing metadata, or timeout returns a failure. Opening QQ Music and dismissing its Max card leave playback owned by QQ Music. Local Max playback retains its existing foreground/audio-focus rules. Duplicate tracks without distinct reported identities may be conservatively reported as unconfirmed skips.

## Completing iOS and web playback

Obtain official QQ Music developer/partner documentation and access that explicitly cover these application types, including playback licensing, user authorization, queue controls, and SDK distribution. Tencent's Lianlian H5 QQ Music interface is documented for its IoT panel/mini-program environment; it is not assumed to be a general standalone website API. An approved integration should replace the handoff result only when playback can actually be confirmed.

## Validation

Automated tests cover routing, local fallback, unsupported handoffs, permission checks/revocation, no-op skips, delayed acknowledgements, buffering versus pause, and command cancellation. Real QQ Music device verification is still required: SDK-free Android behavior depends on the installed application's media-session implementation. No physical QQ Music playback has been verified by the automated tests.

Primary references:

- [Android MediaSessionManager](https://developer.android.com/reference/android/media/session/MediaSessionManager)
- [Apple systemMusicPlayer](https://developer.apple.com/documentation/mediaplayer/mpmusicplayercontroller/systemmusicplayer)
- [Tencent Lianlian H5 QQ Music methods](https://cloud.tencent.com/document/product/1081/67456)
- [QQ Music official website](https://y.qq.com/)
