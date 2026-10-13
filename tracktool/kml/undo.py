"""Legacy API retained solely to explain the retired undo command."""

from dataclasses import dataclass, field

from ..errors import UserInputError


@dataclass(frozen=True)
class UndoOutcome:
    """What one `archive undo` did: the records reversed, and what it left.

    `not_undone` is deliberately not empty on a partial undo: the record is
    consumed either way, or it would keep standing in front of older ones
    forever, so what could not be reversed has to be said out loud.
    """

    undone: list[int] = field(default_factory=list)
    not_undone: list[str] = field(default_factory=list)
    mismatched: bool = False

    @property
    def ok(self) -> bool:
        """Whether the archive came all the way back."""
        return not self.not_undone and not self.mismatched


def undo_last(zip_path: str | None = None, steps: int = 1, force: bool = False) -> UndoOutcome:
    raise UserInputError(
        "Archive undo is retired for SQLite; use pop / push, archive recover, "
        "or import a backup ZIP into a new directory. Legacy history is retained."
    )
