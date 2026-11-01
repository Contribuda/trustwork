# Public home availability evidence

Source: `5d43d0db44df703273f47b6d5aa92f13c8f0ab7b`. Real compiled local Next server, demo mode off, unavailable loopback API. No fixture content was substituted.

Both Russian375 and desktop1280 views returned HTTP200, displayed the localized unavailable message, and had no horizontal overflow or browser errors. The conductor inspected both images. These checks do not establish native translation or manual screen-reader acceptance.

The prior full-CI HTTP500 was fixed by independent publication read handling. A first visual check then caught the mobile CSS hiding status copy; the dedicated status style fixes that. The first final smoke run timed out while another build was active; the separate run after both builds completed passed. The full failure history and logs are retained in the conductor handoff.
