defmodule Trackdidia.Repo.Migrations.CreateResolutions do
  use Ecto.Migration

  def change do
    create table(:resolutions) do
      add :title, :string
      add :description, :string
      add :days, {:array, :string}

      timestamps()
    end

  end
end
