import UIKit
import RnBrownfieldReact

/// The host's own first screen, written in UIKit. Its button pushes the React
/// Native screen onto the navigation stack; React Native's `popToNative()` pops
/// it back to this controller.
final class NativeViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.95, green: 0.96, blue: 0.97, alpha: 1)

        let title = UILabel()
        title.text = "Hello from iOS Native"
        title.font = .systemFont(ofSize: 22, weight: .semibold)
        title.textColor = UIColor(red: 0.07, green: 0.09, blue: 0.15, alpha: 1)

        let body = UILabel()
        body.text = "This screen is plain UIKit, owned by the host app. "
            + "The button pushes a ReactNativeViewController full-screen."
        body.font = .systemFont(ofSize: 16)
        body.textColor = UIColor(red: 0.22, green: 0.26, blue: 0.32, alpha: 1)
        body.numberOfLines = 0

        var config = UIButton.Configuration.filled()
        config.title = "Open React Native"
        config.cornerStyle = .medium
        let button = UIButton(configuration: config)
        button.addTarget(self, action: #selector(openReactNative), for: .touchUpInside)

        let card = UIStackView(arrangedSubviews: [title, body, button])
        card.axis = .vertical
        card.spacing = 12
        card.alignment = .fill
        card.backgroundColor = .white
        card.layer.cornerRadius = 16
        card.isLayoutMarginsRelativeArrangement = true
        card.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 24, leading: 24, bottom: 24, trailing: 24)
        card.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(card)
        NSLayoutConstraint.activate([
            card.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            card.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            card.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])
    }

    @objc private func openReactNative() {
        // "RnBrownfield" is the component registered in the React Native
        // project's index.js.
        let reactNativeViewController = ReactNativeViewController(
            moduleName: "RnBrownfield",
            initialProperties: ["host": "BrownfieldHost (iOS)"]
        )
        // ReactNativeViewController installs the React Native view one main-queue
        // turn after its view loads. Load the view now and push on the next turn,
        // so the navigation controller lays out the React Native view rather
        // than the placeholder that was there at push time.
        reactNativeViewController.loadViewIfNeeded()
        DispatchQueue.main.async { [weak self] in
            self?.navigationController?.pushViewController(reactNativeViewController, animated: true)
        }
    }
}
