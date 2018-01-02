defmodule Trackdidia.ResolutionsTest do
  use Trackdidia.DataCase

  alias Trackdidia.Resolutions

  describe "resolutions" do
    alias Trackdidia.Resolutions.Resolution

    @valid_attrs %{description: "some description", title: "some title"}
    @update_attrs %{description: "some updated description", title: "some updated title"}
    @invalid_attrs %{description: nil, title: nil}

    def resolution_fixture(attrs \\ %{}) do
      {:ok, resolution} =
        attrs
        |> Enum.into(@valid_attrs)
        |> Resolutions.create_resolution()

      resolution
    end

    test "list_resolutions/0 returns all resolutions" do
      resolution = resolution_fixture()
      assert Resolutions.list_resolutions() == [resolution]
    end

    test "get_resolution!/1 returns the templates with given id" do
      resolution = resolution_fixture()
      assert Resolutions.get_resolution!(resolution.id) == resolution
    end

    test "create_resolution/1 with valid data creates a templates" do
      assert {:ok, %Resolution{} = resolution} = Resolutions.create_resolution(@valid_attrs)
      assert resolution.description == "some description"
      assert resolution.title == "some title"
    end

    test "create_resolution/1 with invalid data returns error changeset" do
      assert {:error, %Ecto.Changeset{}} = Resolutions.create_resolution(@invalid_attrs)
    end

    test "update_resolution/2 with valid data updates the templates" do
      resolution = resolution_fixture()
      assert {:ok, resolution} = Resolutions.update_resolution(resolution, @update_attrs)
      assert %Resolution{} = resolution
      assert resolution.description == "some updated description"
      assert resolution.title == "some updated title"
    end

    test "update_resolution/2 with invalid data returns error changeset" do
      resolution = resolution_fixture()
      assert {:error, %Ecto.Changeset{}} = Resolutions.update_resolution(resolution, @invalid_attrs)
      assert resolution == Resolutions.get_resolution!(resolution.id)
    end

    test "delete_resolution/1 deletes the templates" do
      resolution = resolution_fixture()
      assert {:ok, %Resolution{}} = Resolutions.delete_resolution(resolution)
      assert_raise Ecto.NoResultsError, fn -> Resolutions.get_resolution!(resolution.id) end
    end

    test "change_resolution/1 returns a templates changeset" do
      resolution = resolution_fixture()
      assert %Ecto.Changeset{} = Resolutions.change_resolution(resolution)
    end
  end
end
