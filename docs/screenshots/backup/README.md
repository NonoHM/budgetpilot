# Backup and restore screenshots

Captured with `scripts/doc-screenshots.mjs`, group `backup`, at 1920x1080
against a running instance in English.

Both images frame the same _Backup and restore_ section; the second one has
the restore disclosure open, because the warning it reveals is the point of
the image.

Opening it is done by walking up from the "Restore a backup" title to the
nearest ancestor that owns a disclosure button, rather than by index. Two
disclosures on that page carry the label **Show options**, and picking the
second one opened the other section, with no error, and with a capture that
looked plausible because the section it framed was the right one.
