'use client';

import { useRef, useState } from 'react';

import { ApiError, uploadImageMemo } from '../lib/api-client';

/**
 * Photograph a whiteboard, notebook page or sticky note.
 *
 * The browser has no camera UI of its own here; the file input's `capture`
 * hint opens the camera on a phone and the picker on a desktop. The fence is
 * the same as voice: 202, then drafts the user approves.
 */
export function PhotoUpload({ onUploaded }: { onUploaded: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function upload(file: File): Promise<void> {
    setBusy(true);
    setMessage('Sent — reading your photo…');

    try {
      await uploadImageMemo(file);
      onUploaded();
    } catch (caught) {
      setMessage(caught instanceof ApiError ? caught.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (input.current !== null) input.current.value = '';
    }
  }

  return (
    <div className="photo-upload">
      <input
        ref={input}
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        hidden
        type="file"
        onChange={(event) => {
          const file = event.target.files?.[0];

          if (file !== undefined) void upload(file);
        }}
      />
      <button
        type="button"
        className="photo-upload-button"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {busy ? 'Sending…' : 'Add a photo'}
      </button>
      {message === null ? null : <span className="photo-upload-message">{message}</span>}
    </div>
  );
}
