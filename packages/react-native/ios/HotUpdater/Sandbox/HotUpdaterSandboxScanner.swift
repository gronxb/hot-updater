#if HOT_UPDATER_SANDBOX_LAYER
import AVFoundation
import UIKit

/// The in-app QR scanner. The camera permission is asked for here, on the first
/// scan, and only a sandbox link closes it: the coordinator checks and confirms
/// that link like any other.
final class HotUpdaterSandboxScanner: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private let onLink: (URL) -> Void
    private var isDone = false

    init(onLink: @escaping (URL) -> Void) {
        self.onLink = onLink
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let close = UIButton(type: .system)
        close.setTitle("Close", for: .normal)
        close.setTitleColor(.white, for: .normal)
        close.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        close.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(close)
        NSLayoutConstraint.activate([
            close.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            close.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
        ])
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            DispatchQueue.main.async {
                if granted {
                    self?.start()
                } else {
                    self?.showMessage("Allow camera access in Settings to scan.")
                }
            }
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        stopSession()
    }

    @objc private func closeTapped() {
        dismiss(animated: true)
    }

    private func start() {
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input) else {
            showMessage("No camera on this device.")
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            showMessage("This camera can't read QR codes.")
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.frame = view.bounds
        preview.videoGravity = .resizeAspectFill
        view.layer.insertSublayer(preview, at: 0)
        let session = session
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
    }

    private func stopSession() {
        let session = session
        DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
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
        dismiss(animated: true) { self.onLink(url) }
    }

    private func showMessage(_ text: String) {
        let message = UILabel()
        message.text = text
        message.textColor = .white
        message.textAlignment = .center
        message.numberOfLines = 0
        message.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(message)
        NSLayoutConstraint.activate([
            message.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            message.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            message.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])
    }
}
#endif
