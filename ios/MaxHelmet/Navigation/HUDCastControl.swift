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
            Label(client.active ? L("cast.label.stop") : L("cast.label.start"), systemImage: "display")
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
                            title: L("cast.connectTitle"),
                            footer: L("cast.connectFooter")
                        ) {
                            VisorFieldRow(title: L("cast.address")) {
                                TextField(L("cast.addressExample"), text: $address)
                                    .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                                    .visorFont(.subhead, mono: true)
                            }
                            VisorFieldRow(title: L("cast.code"), divider: false) {
                                SecureField(L("cast.codePlaceholder"), text: $code)
                                    .keyboardType(.numberPad)
                                    .visorFont(.subhead, mono: true)
                            }
                        }
                        VStack(spacing: Visor.Space.s2) {
                            Button(L("cast.start")) { client.connect(address: address, code: code); code = "" }
                                .buttonStyle(.visor(.primary))
                                .disabled(!HUDCastClient.supported || client.active)
                            if client.active {
                                Button(L("cast.label.stop")) { client.stop() }
                                    .buttonStyle(.visor(.destructive))
                            }
                        }
                        VisorGroup(
                            title: L("cast.statusTitle"),
                            footer: L("cast.statusFooter")
                        ) {
                            VisorRow(title: client.status, divider: false)
                        }
                    }
                    .padding(Visor.Space.s4)
                }
                .background(Visor.bg)
                .navigationTitle(L("cast.navTitle"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(Visor.bg, for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("common.done")) { showingSetup = false } } }
            }
            .tint(Visor.accent)
            .presentationBackground(Visor.bg)
            .presentationCornerRadius(Visor.Radius.sheet)
        }
    }
}
