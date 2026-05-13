from app.models.measurement import Measurement


def insert_measurements(
    db,
    rows,
    station_id,
    variable_id,
    file_id
):

    measurements = []

    for row in rows:

        measurement = Measurement(
            station_id=station_id,
            variable_id=variable_id,
            file_id=file_id,
            measured_at=row["measured_at"],
            value=row["value"]
        )

        measurements.append(measurement)

    db.bulk_save_objects(measurements)

    db.commit()

    return len(measurements)