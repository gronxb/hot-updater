#if HOT_UPDATER_SANDBOX_LAYER
import AVFoundation
import UIKit

/// The in-app QR scanner's camera, shown once camera access is allowed: the
/// sheet around it asks for access. Only a sandbox link is passed on: the
/// coordinator checks and confirms that link like any other. Whoever shows it
/// closes it.
final class HotUpdaterSandboxScanner: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private let onLink: (URL) -> Void
    private let onUnavailable: (String) -> Void
    private var preview: AVCaptureVideoPreviewLayer?
    private var isDone = false

    init(onLink: @escaping (URL) -> Void, onUnavailable: @escaping (String) -> Void) {
        self.onLink = onLink
        self.onUnavailable = onUnavailable
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        start()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        let session = session
        DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
    }

    private func start() {
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input) else {
            onUnavailable("No camera on this device.")
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            onUnavailable("This camera can't read QR codes.")
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.frame = view.bounds
        preview.videoGravity = .resizeAspectFill
        view.layer.insertSublayer(preview, at: 0)
        self.preview = preview
        let session = session
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput objects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !isDone,
              let value = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue,
              let url = URL(string: value),
              HotUpdaterSandboxLink.isSandboxScheme(url.scheme) else {
            return
        }
        isDone = true
        onLink(url)
    }
}
#endif
