import uuid
import pandas as pd
from sqlalchemy.orm import Session
from psycopg2.extras import execute_values

CHUNK = 2_000


def insert_measurements(
    db:          Session,
    df:          pd.DataFrame,
    station_id:  str,
    variable_id: str,
    file_id:     str,
) -> int:
    df = df.dropna(subset=["value"]).copy()

    if df.empty:
        return 0

    sid = str(uuid.UUID(station_id))
    vid = str(uuid.UUID(variable_id))
    fid = str(uuid.UUID(file_id))

    records = [
        (
            sid,
            vid,
            fid,
            row.measured_at.isoformat() if hasattr(row.measured_at, "isoformat") else str(row.measured_at),
            float(row.value),
        )
        for row in df.itertuples(index=False)
    ]

    sql = """
        INSERT INTO measurements
            (station_id, variable_id, file_id, measured_at, value)
        VALUES %s
        ON CONFLICT (station_id, variable_id, measured_at)
        DO UPDATE SET
            value   = EXCLUDED.value,
            file_id = EXCLUDED.file_id
    """

    template = "(%s::uuid, %s::uuid, %s::uuid, %s::timestamptz, %s)"

    raw_conn = db.get_bind().raw_connection()
    inserted = 0

    try:
        with raw_conn.cursor() as cur:
            # Deshabilitar timeout para esta sesión
            cur.execute("SET LOCAL statement_timeout = 0")

            for i in range(0, len(records), CHUNK):
                batch = records[i : i + CHUNK]
                execute_values(cur, sql, batch, template=template)
                inserted += cur.rowcount

        raw_conn.commit()

    except Exception:
        raw_conn.rollback()
        raise

    finally:
        raw_conn.close()

    return inserted