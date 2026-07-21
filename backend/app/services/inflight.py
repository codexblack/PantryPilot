"""Short-lived, process-local de-duplication for active provider requests."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from typing import TypeVar

ResultT = TypeVar("ResultT")


@dataclass
class _InFlightOperation[ResultT]:
    task: asyncio.Task[ResultT]
    waiters: int = 0


class InFlightRequestRegistry[ResultT]:
    """Coalesce identical active requests without retaining completed results."""

    def __init__(self, task_name_prefix: str):
        self._task_name_prefix = task_name_prefix
        self._operations: dict[str, _InFlightOperation[ResultT]] = {}

    async def run(
        self,
        key: str,
        operation: Callable[[], Awaitable[ResultT]],
    ) -> ResultT:
        """Wait for a shared operation and cancel it when its final caller leaves."""
        entry = self._operations.get(key)
        if entry is None:
            task = asyncio.create_task(
                operation(),
                name=f"{self._task_name_prefix}:{key[:40]}",
            )
            entry = _InFlightOperation(task=task)
            self._operations[key] = entry
            task.add_done_callback(
                lambda completed, operation_key=key: self._discard(operation_key, completed)
            )

        entry.waiters += 1
        try:
            return await asyncio.shield(entry.task)
        finally:
            entry.waiters -= 1
            if entry.waiters == 0 and not entry.task.done():
                entry.task.cancel()

    async def drain(self) -> None:
        """Wait for active operations during graceful process shutdown."""
        tasks = tuple(entry.task for entry in self._operations.values())
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def __len__(self) -> int:
        return len(self._operations)

    def _discard(self, key: str, completed: asyncio.Task[ResultT]) -> None:
        entry = self._operations.get(key)
        if entry is not None and entry.task is completed:
            self._operations.pop(key, None)
        if not completed.cancelled():
            with suppress(asyncio.CancelledError):
                completed.exception()
