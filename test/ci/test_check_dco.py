from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check_dco.py"
SPEC = importlib.util.spec_from_file_location("check_dco", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
CHECK_DCO = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CHECK_DCO
SPEC.loader.exec_module(CHECK_DCO)


def _commit(
    *,
    name: str = "Contributor",
    email: str = "contributor@example.com",
    message: str = "fix: example",
):
    return CHECK_DCO.Commit("abc123", name, email, message)


def test_matching_author_signoff_is_accepted() -> None:
    commit = _commit(
        message="fix: example\n\nSigned-off-by: Contributor <contributor@example.com>"
    )
    assert CHECK_DCO.has_author_signoff(commit)


def test_exact_dependabot_actor_and_author_range_is_trusted() -> None:
    commits = [
        _commit(
            name=CHECK_DCO.DEPENDABOT_AUTHOR_NAME,
            email=CHECK_DCO.DEPENDABOT_AUTHOR_EMAIL,
        )
    ]
    assert CHECK_DCO.is_trusted_dependabot_range(commits, CHECK_DCO.DEPENDABOT_ACTOR)


def test_human_actor_cannot_bypass_with_dependabot_authorship() -> None:
    commits = [
        _commit(
            name=CHECK_DCO.DEPENDABOT_AUTHOR_NAME,
            email=CHECK_DCO.DEPENDABOT_AUTHOR_EMAIL,
        )
    ]
    assert not CHECK_DCO.is_trusted_dependabot_range(commits, "human-maintainer")


def test_dependabot_actor_cannot_bypass_a_mixed_or_forged_range() -> None:
    genuine = _commit(
        name=CHECK_DCO.DEPENDABOT_AUTHOR_NAME,
        email=CHECK_DCO.DEPENDABOT_AUTHOR_EMAIL,
    )
    human = _commit()
    forged = _commit(
        name=CHECK_DCO.DEPENDABOT_AUTHOR_NAME,
        email="attacker@example.com",
    )
    assert not CHECK_DCO.is_trusted_dependabot_range(
        [genuine, human], CHECK_DCO.DEPENDABOT_ACTOR
    )
    assert not CHECK_DCO.is_trusted_dependabot_range(
        [forged], CHECK_DCO.DEPENDABOT_ACTOR
    )
