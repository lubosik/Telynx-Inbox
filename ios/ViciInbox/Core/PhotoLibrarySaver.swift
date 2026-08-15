import Foundation
import Photos
import UIKit

enum PhotoLibrarySaveError: LocalizedError {
    case invalidResponse
    case invalidImage
    case permissionDenied
    case writeFailed

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The image could not be downloaded. Please try again."
        case .invalidImage:
            return "This attachment is not a supported image."
        case .permissionDenied:
            return "Vici Inbox does not have permission to add images to Photos. Enable Photos access in Settings and try again."
        case .writeFailed:
            return "The image could not be saved to Photos. Please try again."
        }
    }
}

enum PhotoLibrarySaver {
    static func imageData(from url: URL) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse,
              (200...299).contains(http.statusCode),
              !data.isEmpty else {
            throw PhotoLibrarySaveError.invalidResponse
        }
        guard UIImage(data: data) != nil else { throw PhotoLibrarySaveError.invalidImage }
        return data
    }

    /// Downloads an attachment and preserves its original bytes when adding it
    /// to Photos (important for animated GIFs). Only add-only permission is
    /// requested; the app never needs general read access to the photo library.
    static func saveImage(from url: URL) async throws {
        let data = try await imageData(from: url)

        let status = await requestAddOnlyAuthorization()
        guard status == .authorized || status == .limited else {
            throw PhotoLibrarySaveError.permissionDenied
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges {
                let request = PHAssetCreationRequest.forAsset()
                let options = PHAssetResourceCreationOptions()
                options.originalFilename = url.lastPathComponent.isEmpty ? "Vici-Inbox-Image" : url.lastPathComponent
                request.addResource(with: .photo, data: data, options: options)
            } completionHandler: { success, error in
                if success {
                    continuation.resume()
                } else {
                    continuation.resume(throwing: error ?? PhotoLibrarySaveError.writeFailed)
                }
            }
        }
    }

    private static func requestAddOnlyAuthorization() async -> PHAuthorizationStatus {
        await withCheckedContinuation { continuation in
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                continuation.resume(returning: status)
            }
        }
    }
}
