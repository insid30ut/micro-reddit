'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { normalizeCommunitySlug } from '@/lib/communities/slug';

export function CreateCommunityForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [artworkUrl, setArtworkUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function handleNameChange(value: string): void {
    setName(value);
    if (!slugManuallyEdited) {
      setSlug(normalizeCommunitySlug(value));
    }
  }

  function handleSlugChange(value: string): void {
    setSlugManuallyEdited(true);
    setSlug(normalizeCommunitySlug(value));
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErrorMessage(null);
    setSubmitting(true);

    try {
      const response = await fetch('/api/communities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          slug,
          description,
          artworkUrl: artworkUrl.trim() || null,
        }),
      });

      const payload = (await response.json()) as {
        community?: { slug: string };
        message?: string;
      };

      if (!response.ok || !payload.community) {
        throw new Error(payload.message ?? 'Failed to create community.');
      }

      router.push(`/communities/${payload.community.slug}`);
      router.refresh();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to create community.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="space-y-5 rounded-xl border border-slate-800 bg-slate-900/70 p-6"
    >
      <div>
        <h2 className="text-lg font-semibold text-white">
          Screen 3 — Create Community (Initial Status: PENDING_MINT)
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          Communities start in <code className="text-amber-300">PENDING_MINT</code>{' '}
          status and transition to <code className="text-emerald-300">ACTIVE</code>{' '}
          only after the 1Sat Ordinal NFT is minted and independently verified on
           the backend.
        </p>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="rounded-lg border border-rose-500/40 bg-rose-950/40 p-3 text-xs text-rose-300"
        >
          <span className="font-semibold">Error:</span> {errorMessage}
        </div>
      )}

      <div>
        <label
          htmlFor="community-name"
          className="block text-xs font-medium text-slate-300"
        >
          Community Name
        </label>
        <input
          id="community-name"
          type="text"
          required
          minLength={2}
          maxLength={120}
          value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder="Technology & Programming"
          className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
        />
      </div>

      <div>
        <label
          htmlFor="community-slug"
          className="block text-xs font-medium text-slate-300"
        >
          Unique URL Slug
        </label>
        <input
          id="community-slug"
          type="text"
          required
          minLength={2}
          maxLength={64}
          value={slug}
          onChange={(e) => handleSlugChange(e.target.value)}
          placeholder="technology-programming"
          className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-emerald-300 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
        />
      </div>

      <div>
        <label
          htmlFor="community-description"
          className="block text-xs font-medium text-slate-300"
        >
          Description
        </label>
        <textarea
          id="community-description"
          required
          minLength={10}
          maxLength={2000}
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="A community for software development, programming, and Bitcoin SV ordinals."
          className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
        />
      </div>

      <div>
        <label
          htmlFor="community-artwork"
          className="block text-xs font-medium text-slate-300"
        >
          Artwork / Content URL (Optional)
        </label>
        <input
          id="community-artwork"
          type="url"
          value={artworkUrl}
          onChange={(e) => setArtworkUrl(e.target.value)}
          placeholder="https://example.com/community-badge.png"
          className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
        />
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
      >
        {submitting
          ? 'Creating Pending Community...'
          : 'Create Pending Community & Proceed to NFT Mint'}
      </button>
    </form>
  );
}
