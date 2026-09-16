package com.horizon.maxhelmet

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.content.Intent
import android.content.res.Configuration
import android.view.Surface
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import com.horizon.maxhelmet.ui.AgentScreen
import com.horizon.maxhelmet.ui.MainViewModel
import com.horizon.maxhelmet.ui.theme.MaxHelmetTheme
import com.horizon.maxhelmet.actions.DeviceActivityHost
import kotlinx.coroutines.CompletableDeferred

class MainActivity : ComponentActivity(), DeviceActivityHost {

    private val viewModel: MainViewModel by viewModels()
    private var musicSelectionTicket: Int? = null
    private val musicPicker = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val ticket = musicSelectionTicket
        musicSelectionTicket = null
        if (ticket != null) {
            uris.forEach { uri -> runCatching { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } }
            viewModel.music.completeSelection(ticket, uris)
        }
    }
    private var actionPermission: CompletableDeferred<Boolean>? = null
    private val actionPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        viewModel.refreshPhoneLocation()
        actionPermission?.complete(grants.isNotEmpty() && grants.values.all { it }); actionPermission = null
    }

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            // Mic is required; location, Bluetooth, and notifications are
            // best-effort (the relay falls back to demo weather without
            // coordinates, and audio falls back to the phone mic/speaker).
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
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

    override fun onStart() {
        super.onStart()
        viewModel.deviceActions.host = this
        viewModel.camera.attach(this, window.decorView.display?.rotation ?: Surface.ROTATION_0)
        viewModel.music.launchPicker = { ticket ->
            musicSelectionTicket = ticket
            musicPicker.launch(arrayOf("audio/*"))
        }
        viewModel.music.setAppForeground(true)
        viewModel.refreshPhoneLocation()
    }

    override fun onStop() {
        viewModel.helmetDiscovery.stop()
        if (viewModel.deviceActions.host === this) viewModel.deviceActions.host = null
        viewModel.camera.detach(this)
        viewModel.music.launchPicker = null
        viewModel.music.setAppForeground(false)
        actionPermission?.complete(false); actionPermission = null
        super.onStop()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        window.decorView.post { viewModel.camera.updateRotation(window.decorView.display?.rotation ?: Surface.ROTATION_0) }
    }

    override suspend fun requestPermission(permission: String): Boolean {
        if (ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED) return true
        if (actionPermission != null) return false
        val pending = CompletableDeferred<Boolean>()
        actionPermission = pending
        actionPermissionLauncher.launch(if (permission == Manifest.permission.ACCESS_FINE_LOCATION) arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION) else arrayOf(permission))
        return try { pending.await() } finally { if (actionPermission === pending) actionPermission = null }
    }

    override fun launch(intent: Intent): Boolean = runCatching { startActivity(intent); true }.getOrDefault(false)

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
