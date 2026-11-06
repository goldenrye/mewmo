from logging.config import fileConfig

from alembic import context

from app.database import engine
from app.models import Base

fileConfig(context.config.config_file_name)


def run(connection):
    context.configure(connection=connection, target_metadata=Base.metadata)
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    context.configure(url=str(engine().url), target_metadata=Base.metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    supplied = context.config.attributes.get("connection")
    if supplied is not None:
        run(supplied)
    else:
        with engine().connect() as connection:
            run(connection)
