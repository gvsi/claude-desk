"""`make kernel-contract` runs the real-kernel variants for exactly the kernel plans that have landed."""

from pathlib import Path

import pytest

from tests.kernel_contract.real_kernel import landed_kernel_plans


def test_landed_kernel_plans(tmp_path: Path):
    landed = tmp_path / "landed.toml"
    assert landed_kernel_plans(landed) == []                   # no file yet: nothing has landed
    landed.write_text('plans = ["master"]\n')
    assert landed_kernel_plans(landed) == []
    landed.write_text('plans = ["master", "01a", "02a", "01b", "01c-setup"]\n')
    assert landed_kernel_plans(landed) == ["01a", "01b", "01c-setup"]
    landed.write_text('plans = "01a"\n')
    with pytest.raises(ValueError):
        landed_kernel_plans(landed)
