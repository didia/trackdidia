defmodule Trackdidia.Repo do
  use Ecto.Repo, otp_app: :trackdidia

  @doc """
  Dynamically loads the repository url from the
  DATABASE_URL environment variable.
  """
  def init(_, opts) do
    {:ok, Keyword.put(opts, :url, Application.get_env(:trackdidia, Trackdidia.Repo)[:url])}
  end
end
