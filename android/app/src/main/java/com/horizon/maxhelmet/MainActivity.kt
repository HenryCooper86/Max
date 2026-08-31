package com.horizon.maxhelmet

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import com.horizon.maxhelmet.ui.AgentScreen
import com.horizon.maxhelmet.ui.MainViewModel
import com.horizon.maxhelmet.ui.theme.MaxHelmetTheme

class MainActivity : ComponentActivity() {

    private val viewModel: MainViewModel by viewModels()

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            // Mic is required; location, Bluetooth, and notifications are
            // best-effort (the relay falls back to demo weather without
            // coordinates, and audio falls back to the phone mic/speaker).
            if (grants[Manifest.permission.RECORD_AUDIO] == true) {
                viewModel.toggleHandsFree()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Riders glance at the HUD; keep it visible while the app is open.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        setContent {
            MaxHelmetTheme {
                AgentScreen(
                    viewModel = viewModel,
                    onToggleHandsFree = ::toggleHandsFreeWithPermissions,
                    onExportTranscript = { viewModel.exportTranscript(this) }
                )
            }
        }
    }

    private fun toggleHandsFreeWithPermissions() {
        // Stopping never needs permissions.
        if (viewModel.sessionState.value.handsFree) {
            viewModel.toggleHandsFree()
            return
        }

        val wanted = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            add(Manifest.permission.ACCESS_FINE_LOCATION)
            add(Manifest.permission.ACCESS_COARSE_LOCATION)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                add(Manifest.permission.BLUETOOTH_CONNECT)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        val missing = wanted.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (missing.isEmpty()) {
            viewModel.toggleHandsFree()
        } else {
            permissionLauncher.launch(missing.toTypedArray())
        }
    }
}
