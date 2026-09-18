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
            Label(client.active ? "停止投屏" : "投屏到 HUD", systemImage: "display")
        }
        .accessibilityIdentifier("castToHUD")
        .sheet(isPresented: $showingSetup) {
            NavigationStack {
                Form {
                    Section("连接 RDK 显示屏") {
                        Text("手机与 RDK 连接同一 Wi-Fi。在 RDK 打开 HUD 投屏页面，输入屏幕上的地址和连接码。")
                        TextField("RDK 地址，例如 192.168.1.20:8080", text: $address)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        SecureField("六位连接码", text: $code).keyboardType(.numberPad)
                        Button("开始投屏") { client.connect(address: address, code: code); code = "" }
                            .disabled(!HUDCastClient.supported || client.active)
                        if client.active { Button("停止投屏") { client.stop() } }
                    }
                    Section {
                        Text(client.status)
                        Text("开发版 Wi-Fi 原型：仅在可信网络使用。导航期间后台继续发送位置和路线。RDK 配置街道地图后，前后台均显示详细地图；连接中断后请手动重连。")
                    }
                }
                .navigationTitle("投屏到 HUD")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showingSetup = false } } }
            }
        }
    }
}
