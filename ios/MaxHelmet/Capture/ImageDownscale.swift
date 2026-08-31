import UIKit

extension UIImage {
    /// Aspect-fit downscale so the longest side is `maxDimension`.
    func downscaled(to maxDimension: CGFloat) -> UIImage? {
        let longest = max(size.width, size.height)
        guard longest > maxDimension else { return self }
        let scale = maxDimension / longest
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        return UIGraphicsImageRenderer(size: target).image { _ in
            draw(in: CGRect(origin: .zero, size: target))
        }
    }
}
