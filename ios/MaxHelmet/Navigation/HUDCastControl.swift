import SwiftUI

struct HUDCastControl: View {
    @ObservedObject var client: HUDCastClient
    @State private var showingSetup = false
    @State private var address = ""
    @State private var code = ""

    var body: some View {
        Button {
            if client.active { client.stop() } else { showingSetup = true }
        } label: {
            Label(client.active ? "断开 HUD" : "投屏到 HUD", systemImage: "display")
                .visorFont(.footnote, .semibold)
        }
        .tint(Visor.accent)
        .frame(minHeight: Visor.hit)
        .accessibilityIdentifier("castToHUD")
        .onAppear { address = client.savedAddress }
        .sheet(isPresented: $showingSetup) {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: Visor.Space.s6) {
                        VisorGroup(
                            title: "连接 RDK 显示屏",
                            footer: "手机与 RDK 连接同一 Wi-Fi。在 RDK 打开 HUD 投屏页面，首次输入屏幕上的地址和连接码。配对成功后，导航会自动重连；主动断开会暂停自动连接。"
                        ) {
                            VisorFieldRow(title: "RDK 地址") {
                                TextField("例如 192.168.1.20:8080", text: $address)
                                    .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                                    .visorFont(.subhead, mono: true)
                            }
                            VisorFieldRow(title: "连接码", divider: false) {
                                SecureField("六位连接码", text: $code)
                                    .keyboardType(.numberPad)
                                    .visorFont(.subhead, mono: true)
                            }
                        }
                        VStack(spacing: Visor.Space.s2) {
                            Button("开始投屏") { client.connect(address: address, code: code); code = "" }
                                .buttonStyle(.visor(.primary))
                                .disabled(!HUDCastClient.supported || client.active)
                            if client.active {
                                Button("断开 HUD") { client.stop() }
                                    .buttonStyle(.visor(.destructive))
                            }
                        }
                        VisorGroup(
                            title: "状态",
                            footer: "开发版 Wi-Fi 原型：仅在可信网络使用。导航期间后台继续发送位置和路线。RDK 配置街道地图后，前后台均显示详细地图；同一网络且导航运行时自动重连。重新连接已配对 RDK 可留空连接码。"
                        ) {
                            VisorRow(title: client.status, divider: false)
                        }
                    }
                    .padding(Visor.Space.s4)
                }
                .background(Visor.bg)
                .navigationTitle("投屏到 HUD")
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(Visor.bg, for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showingSetup = false } } }
            }
            .tint(Visor.accent)
            .presentationBackground(Visor.bg)
            .presentationCornerRadius(Visor.Radius.sheet)
        }
    }
}
