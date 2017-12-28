defmodule TrackdidiaWeb.Heatlh.ControllerTest do
  use TrackdidiaWeb.ConnCase

  test "GET /health", %{conn: conn} do
    conn = get(conn, "/health")
    assert text_response(conn, 200) == "ok"
  end
end
